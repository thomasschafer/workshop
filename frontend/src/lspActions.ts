// What a language server answers with, read into the shapes the editor acts on: places in files,
// and edits to them. Workshop edits one file at a time, so each is sorted into what's in the open
// file and what's elsewhere.

export interface Position {
  readonly line: number;
  readonly character: number;
}

export interface Range {
  readonly start: Position;
  readonly end: Position;
}

export interface Location {
  readonly uri: string;
  readonly range: Range;
}

export interface TextEdit {
  readonly range: Range;
  readonly newText: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isPosition(value: unknown): value is Position {
  return isRecord(value) && typeof value.line === "number" && typeof value.character === "number";
}

function isRange(value: unknown): value is Range {
  return isRecord(value) && isPosition(value.start) && isPosition(value.end);
}

/**
 * The places a request such as `textDocument/definition` answers with, which servers give as one
 * location, a list of them, or a list of links. Throws for anything else, rather than taking a
 * malformed answer to mean there's nowhere to go.
 */
export function locations(result: unknown): Location[] {
  if (result === null || result === undefined) return [];
  const items = Array.isArray(result) ? result : [result];
  return items.map((item: unknown) => {
    if (isRecord(item)) {
      if (typeof item.uri === "string" && isRange(item.range)) {
        return { uri: item.uri, range: item.range };
      }
      const range = item.targetSelectionRange ?? item.targetRange;
      if (typeof item.targetUri === "string" && isRange(range)) {
        return { uri: item.targetUri, range };
      }
    }
    throw new Error("the language server answered with something that isn't a place in a file");
  });
}

/** A language server's edit across files, as it sends one. */
export interface WorkspaceEdit {
  readonly changes?: Readonly<Record<string, readonly TextEdit[]>>;
  readonly documentChanges?: readonly unknown[];
}

/**
 * The edits a workspace edit makes to the file at `uri`, and how many other files it would
 * change or otherwise touch, which Workshop leaves alone.
 */
export function editsFor(
  edit: WorkspaceEdit,
  uri: string,
): { edits: TextEdit[]; elsewhere: number } {
  const byFile = new Map<string, TextEdit[]>();
  let elsewhere = 0;
  const add = (file: string, edits: readonly unknown[]) => {
    const kept = byFile.get(file) ?? [];
    for (const e of edits) {
      if (!isRecord(e) || !isRange(e.range) || typeof e.newText !== "string") {
        throw new Error("the language server sent an edit that can't be read");
      }
      kept.push({ range: e.range, newText: e.newText });
    }
    byFile.set(file, kept);
  };
  if (edit.documentChanges) {
    for (const change of edit.documentChanges) {
      const document = isRecord(change) ? change.textDocument : undefined;
      if (isRecord(change) && isRecord(document) && typeof document.uri === "string") {
        if (!Array.isArray(change.edits)) {
          throw new Error("the language server sent an edit that can't be read");
        }
        add(document.uri, change.edits);
      } else {
        // Creating, renaming or deleting a file.
        elsewhere++;
      }
    }
  } else if (edit.changes) {
    for (const [file, edits] of Object.entries(edit.changes)) add(file, edits);
  }
  for (const [file, edits] of byFile) if (file !== uri && edits.length > 0) elsewhere++;
  return { edits: byFile.get(uri) ?? [], elsewhere };
}

/** Something a language server offers to do, as `textDocument/codeAction` lists them. */
export interface CodeAction {
  readonly title: string;
  readonly edit: WorkspaceEdit | null;
  /** Whether it's a command for the server to run, which Workshop's language client can't follow. */
  readonly command: boolean;
  /** Whether it came without its edit, which the server gives once it's asked for. */
  readonly resolvable: boolean;
  /** Why it can't be used, if the server says so. */
  readonly disabled: string | null;
  /** As the server sent it, to ask for its edit if it came without one. */
  readonly raw: unknown;
}

export function codeActions(result: unknown): CodeAction[] {
  if (result === null || result === undefined) return [];
  if (!Array.isArray(result)) throw new Error("the language server's code actions can't be read");
  return result.map((item: unknown) => {
    if (!isRecord(item) || typeof item.title !== "string") {
      throw new Error("the language server's code actions can't be read");
    }
    // A bare command has its name as a string; an action may carry a command as an object.
    const bare = typeof item.command === "string";
    return {
      title: item.title,
      edit: !bare && isRecord(item.edit) ? (item.edit as WorkspaceEdit) : null,
      command: bare || isRecord(item.command),
      resolvable:
        !bare && !isRecord(item.edit) && (item.data !== undefined || !isRecord(item.command)),
      disabled:
        isRecord(item.disabled) && typeof item.disabled.reason === "string"
          ? item.disabled.reason
          : null,
      raw: item,
    };
  });
}

/** The kinds of code action offered to servers, which answer with none if told of none. */
const CODE_ACTION_KINDS = [
  "",
  "quickfix",
  "refactor",
  "refactor.extract",
  "refactor.inline",
  "refactor.rewrite",
  "source",
  "source.organizeImports",
  "source.fixAll",
];

/**
 * What Workshop does beyond its language client, for the capabilities the client offers as it
 * connects: code actions that come with their edits, or that can be asked for them.
 */
export const EXTRA_CAPABILITIES = {
  codeAction: {
    codeActionLiteralSupport: { codeActionKind: { valueSet: CODE_ACTION_KINDS } },
    resolveSupport: { properties: ["edit"] },
    dataSupport: true,
    disabledSupport: true,
  },
};

/** The text of hover documentation, which servers send as markdown, plain text, or a mix. */
export function hoverMarkdown(contents: unknown): string {
  if (typeof contents === "string") return contents;
  if (Array.isArray(contents)) return contents.map(hoverMarkdown).join("\n\n");
  if (isRecord(contents) && typeof contents.value === "string") {
    // A marked string with a language is code.
    return typeof contents.language === "string"
      ? `\`\`\`${contents.language}\n${contents.value}\n\`\`\``
      : contents.value;
  }
  return "";
}
