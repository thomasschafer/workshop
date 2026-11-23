// Parses GHC 9.14 `-ferror-spans -fdiagnostics-color=never` output into LSP diagnostics and
// extracts inferred top-level signatures from `-Wmissing-signatures` warnings.

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  /** 1 = Error, 2 = Warning, 3 = Information, 4 = Hint */
  severity: 1 | 2 | 3 | 4;
  code?: string | undefined;
  source: string;
  message: string;
}

export const LOCAL_LSP_SOURCE = "Local (GHC 9.14)";

// Matches GHC diagnostic headers emitted with `-ferror-spans`:
//   /tmp/Main.hs:4:8: error: [GHC-88464]
//   /tmp/Main.hs:4:8-13: error: [GHC-83865]
//   /tmp/Main.hs:(4,8)-(6,13): warning: [GHC-38417] [-Wmissing-signatures]
const HEADER_RE =
  /^\/tmp\/Main\.hs:(?:(\d+):(\d+)(?:-(\d+))?|\((\d+),(\d+)\)-\((\d+),(\d+)\)):\s*(error|warning):\s*(?:\[(GHC-\d+)\])?(.*)$/;

// GHC source-snippet gutter lines (`  |`, `4 | bad1 = ...`, `  |        ^^^^^^`).
const SNIPPET_LINE_RE = /^\s*\d*\s*\|/;

function clampRange(range: LspRange, sourceLines: string[]): LspRange {
  if (sourceLines.length === 0) {
    return { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } };
  }
  const maxLine = sourceLines.length - 1;
  const startLine = Math.min(Math.max(0, range.start.line), maxLine);
  const startLineLen = sourceLines[startLine]?.length ?? 0;
  const startChar = Math.min(Math.max(0, range.start.character), startLineLen);

  const endLine = Math.min(Math.max(startLine, range.end.line), maxLine);
  const endLineLen = sourceLines[endLine]?.length ?? 0;
  let endChar = Math.min(Math.max(0, range.end.character), endLineLen);
  if (endLine === startLine && endChar < startChar) {
    endChar = startChar;
  }
  return {
    start: { line: startLine, character: startChar },
    end: { line: endLine, character: endChar },
  };
}

/** Parses GHC stderr into structured LSP diagnostics and inferred top-level type signatures. */
export function parseGhcDiagnostics(
  stderrRaw: string,
  sourceText?: string,
): {
  diagnostics: LspDiagnostic[];
  inferredSignatures: Map<string, string>;
} {
  // Drop the expected `-fno-code` linker panic and `load returned Failed` footer.
  let cleaned = stderrRaw;
  const panicIdx = cleaned.indexOf("libplayground001.so: panic!");
  if (panicIdx !== -1) cleaned = cleaned.slice(0, panicIdx);
  cleaned = cleaned.replace(/\n?user error \(load returned Failed\)\s*$/, "");

  const lines = cleaned.split(/\r?\n/);
  const sourceLines = sourceText !== undefined ? sourceText.split(/\r?\n/) : null;
  const diagnostics: LspDiagnostic[] = [];
  const inferredSignatures = new Map<string, string>();

  let current: {
    range: LspRange;
    severity: 1 | 2;
    code?: string | undefined;
    flagSuffix: string;
    bodyLines: string[];
    inSnippet: boolean;
  } | null = null;

  const flush = () => {
    if (!current) return;
    const rawBody = current.bodyLines
      .map((l) => l.replace(/^ {4}/, ""))
      .join("\n")
      .trim();
    const message = rawBody || current.flagSuffix.trim() || "GHC error";

    // Extract inferred top-level signature from `-Wmissing-signatures` for hover/completion!
    const missingSig = message.match(
      /Top-level binding with no type signature:\s*\n?\s*([a-z_][A-Za-z0-9_']*)\s*::\s*([\s\S]+)/,
    );
    if (missingSig?.[1] && missingSig[2]) {
      const sig = missingSig[2].replace(/\s+/g, " ").trim();
      inferredSignatures.set(missingSig[1], sig);
    }

    diagnostics.push({
      range: sourceLines ? clampRange(current.range, sourceLines) : current.range,
      severity: current.severity,
      ...(current.code ? { code: current.code } : {}),
      source: LOCAL_LSP_SOURCE,
      message,
    });
    current = null;
  };

  for (const line of lines) {
    const m = line.match(HEADER_RE);
    if (m) {
      flush();
      let startLine: number;
      let startCol: number;
      let endLine: number;
      let endCol: number;
      if (m[1] !== undefined && m[2] !== undefined) {
        startLine = Math.max(0, Number.parseInt(m[1], 10) - 1);
        startCol = Math.max(0, Number.parseInt(m[2], 10) - 1);
        endLine = startLine;
        endCol =
          m[3] !== undefined ? Math.max(startCol + 1, Number.parseInt(m[3], 10)) : startCol + 1;
      } else {
        startLine = Math.max(0, Number.parseInt(m[4] ?? "1", 10) - 1);
        startCol = Math.max(0, Number.parseInt(m[5] ?? "1", 10) - 1);
        endLine = Math.max(startLine, Number.parseInt(m[6] ?? "1", 10) - 1);
        endCol = Math.max(0, Number.parseInt(m[7] ?? "1", 10));
      }
      const severity: 1 | 2 = m[8] === "warning" ? 2 : 1;
      const code = m[9];
      const flagSuffix = m[10] ?? "";
      current = {
        range: {
          start: { line: startLine, character: startCol },
          end: { line: endLine, character: endCol },
        },
        severity,
        code,
        flagSuffix,
        bodyLines: [],
        inSnippet: false,
      };
      continue;
    }

    if (!current) continue;

    if (SNIPPET_LINE_RE.test(line)) {
      current.inSnippet = true;
      continue;
    }
    if (current.inSnippet) {
      if (line.trim() === "") {
        current.inSnippet = false;
      }
      continue;
    }
    if (line.startsWith("    ") || line === "") {
      current.bodyLines.push(line);
    } else if (line.trim() !== "") {
      // Unindented non-header line ends the current diagnostic block.
      flush();
    }
  }

  flush();
  return { diagnostics, inferredSignatures };
}
