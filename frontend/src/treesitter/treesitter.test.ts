import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { EditorState } from "@codemirror/state";
import { beforeAll, describe, expect, it } from "vitest";
import {
  buildHelixSyntaxCss,
  buildHighlightDecorations,
  changeSetToEdits,
  getSyntaxTree,
  getTreeStats,
  type HighlightSpan,
  highlightRange,
  loadLanguageBundle,
  resolveScope,
  SyntaxTree,
  scopeToClass,
  setWasmBytesLoader,
  treeSitterExtension,
  WORKSHOP_SYNTAX_SCOPES,
} from "./index";

const HERE = dirname(fileURLToPath(import.meta.url));
const GOLDEN_SOURCE = readFileSync(join(HERE, "fixtures", "haskell.hs"), "utf8");

interface GoldenSpan {
  from: number;
  to: number;
  text: string;
  scopes: string[];
}

const GOLDEN_SPANS = JSON.parse(
  readFileSync(join(HERE, "fixtures", "haskell.golden.json"), "utf8"),
) as GoldenSpan[];

beforeAll(async () => {
  setWasmBytesLoader(async (url) => {
    let filePath = url;
    if (filePath.startsWith("file://")) {
      filePath = fileURLToPath(filePath);
    } else if (filePath.startsWith("/@fs/")) {
      filePath = filePath.slice("/@fs".length);
    } else if (filePath.startsWith("/")) {
      filePath = resolve(process.cwd(), filePath.slice(1));
    }
    const buf = await readFile(filePath);
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  });
  await loadLanguageBundle("haskell");
});

describe("theme scope lookup", () => {
  it("resolves exact scopes, falls back by stripping trailing segments, and returns null if missing", () => {
    const scopes = new Set(["keyword", "keyword.control", "variable", "comment"]);
    expect(resolveScope("keyword.control", scopes)).toBe("keyword.control");
    expect(resolveScope("keyword.control.conditional", scopes)).toBe("keyword.control");
    expect(resolveScope("keyword.storage.type", scopes)).toBe("keyword");
    expect(resolveScope("variable.other.member", scopes)).toBe("variable");
    expect(resolveScope("_name", scopes)).toBeNull();
    expect(resolveScope("punctuation.bracket", scopes)).toBeNull();
  });

  it("maps resolved scopes to CSS class names and builds Helix syntax CSS", () => {
    expect(scopeToClass("keyword")).toBe("syntax-keyword");
    expect(scopeToClass("variable.parameter")).toBe("syntax-variable-parameter");
    expect(scopeToClass("constant.numeric")).toBe("syntax-constant-numeric");

    const css = buildHelixSyntaxCss({
      dark: {
        keyword: { fg: "#cba6f7", modifiers: ["bold"] },
        comment: { fg: "#6c7086", modifiers: ["italic", "dim"] },
        "markup.link.url": { fg: "#89b4fa", modifiers: ["underlined", "crossed_out"] },
      },
    });
    expect(css).toContain("@media (prefers-color-scheme: dark)");
    expect(css).toContain(".cm-content .ts-hl.syntax-keyword{color:#cba6f7;font-weight:700;}");
    expect(css).toContain(
      ".cm-content .ts-hl.syntax-comment{color:#6c7086;font-style:italic;opacity:0.65;}",
    );
    expect(css).toContain(
      ".cm-content .ts-hl.syntax-markup-link-url{color:#89b4fa;text-decoration:underline line-through;}",
    );
    expect(buildHelixSyntaxCss({})).toBeNull();
  });
});

describe("incremental parsing", () => {
  it("keeps the tree identical to a fresh parse across randomised edits including non-ASCII and emoji", () => {
    let seed = 0x1234_5678;
    const nextInt = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };

    // Valid Haskell declarations inserted/removed/edited at line boundaries, including non-ASCII
    // identifiers, arrows, and surrogate-pair emoji in strings and comments.
    const decls = [
      "f0 :: Int -> Int\nf0 λ = λ + 1 -- TODO: 😀 café\n",
      'g0 :: String -> String\ng0 s = "😀→λ" ++ s\n',
      "h0 x y = let z = x * y in z + 2\n",
      "data Tag0 = MkTag0 Int deriving (Eq, Show)\n",
      "-- NOTE: arrow → and emoji 🎉 in comment\n",
    ];

    let state = EditorState.create({
      doc: `module M where\n\n${decls.join("\n")}`,
      extensions: [treeSitterExtension("haskell")],
    });

    const initial = getSyntaxTree(state);
    expect(initial).not.toBeNull();
    expect(initial?.query("textobjects")).not.toBeNull();
    expect(initial?.query("tags")).not.toBeNull();
    expect(initial?.query("rainbows")).not.toBeNull();
    expect(initial?.query("indents")).toBeNull();

    for (let step = 0; step < 50; step++) {
      const doc = state.doc;
      const lineNum = 2 + nextInt(Math.max(1, doc.lines - 1));
      const line = doc.line(Math.min(lineNum, doc.lines));
      const variant = (decls[nextInt(decls.length)] ?? "").replace(/0/g, String(step + 1));

      let changes:
        | { from: number; to: number; insert: string }
        | { from: number; to: number; insert: string }[];
      const op = nextInt(4);
      if (op === 0) {
        changes = { from: line.from, to: line.from, insert: `${variant}\n` };
      } else if (op === 1 && doc.lines > 6) {
        changes = { from: line.from, to: Math.min(doc.length, line.to + 1), insert: "" };
      } else if (op === 2) {
        changes = { from: line.to, to: line.to, insert: " -- λ→😀" };
      } else {
        const secondLine = doc.line(Math.min(doc.lines, Math.max(2, line.number + 2)));
        changes =
          line.to < secondLine.to
            ? [
                { from: line.to, to: line.to, insert: " -- aλ" },
                { from: secondLine.to, to: secondLine.to, insert: " -- b😀" },
              ]
            : { from: line.to, to: line.to, insert: " -- c→" };
      }

      state = state.update({ changes }).state;
      const docText = state.doc.toString();
      const incremental = getSyntaxTree(state);
      expect(incremental).not.toBeNull();

      const fresh = SyntaxTree.parse(docText, "haskell");
      try {
        if (!fresh.tree().rootNode.hasError) {
          expect(incremental?.tree.rootNode.toString()).toBe(fresh.tree().rootNode.toString());
        }

        // Verify UTF-16 node indices match JS string slices on every leaf (no position drift).
        const cursor = incremental?.tree.walk();
        if (cursor) {
          let reachedRoot = false;
          while (!reachedRoot) {
            const node = cursor.currentNode;
            if (node.childCount === 0) {
              expect(docText.slice(node.startIndex, node.endIndex)).toBe(node.text);
            }
            if (cursor.gotoFirstChild()) continue;
            if (cursor.gotoNextSibling()) continue;
            while (!cursor.gotoNextSibling()) {
              if (!cursor.gotoParent()) {
                reachedRoot = true;
                break;
              }
            }
          }
          cursor.delete();
        }
      } finally {
        fresh.delete();
      }
    }
  });

  it("handles changeSetToEdits on surrogate-pair emoji and multi-line inserts without drift", () => {
    const startText = 'a = "😀"\nb = λ\n';
    let state = EditorState.create({ doc: startText });
    const syntax = SyntaxTree.parse(startText, "haskell");
    try {
      const tr = state.update({
        changes: {
          from: startText.indexOf("😀"),
          to: startText.indexOf("😀") + 2,
          insert: '→\n-- TODO: hi\nc = "🎉"',
        },
      });
      const edits = changeSetToEdits(state.doc, tr.changes);
      state = tr.state;
      const nextText = state.doc.toString();
      syntax.update(nextText, edits);

      const fresh = SyntaxTree.parse(nextText, "haskell");
      try {
        expect(syntax.tree().rootNode.toString()).toBe(fresh.tree().rootNode.toString());
        expect(
          highlightRange(syntax, nextText, 0, nextText.length, WORKSHOP_SYNTAX_SCOPES),
        ).toEqual(highlightRange(fresh, nextText, 0, nextText.length, WORKSHOP_SYNTAX_SCOPES));
      } finally {
        fresh.delete();
      }
    } finally {
      syntax.delete();
    }
  });

  it("produces identical highlights to a fresh parse across random edit sequences (locals + injections)", () => {
    let seed = 0x5eed_cafe;
    const nextInt = (max: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };

    const blocks = [
      "-- TODO: first comment (#1)\n",
      "alpha :: Int -> Int\nalpha x = x + 1\n",
      "-- FIXME: second comment @bob\n",
      "beta :: Int -> Int -> Int\nbeta a b = alpha a + b\n",
      'gamma :: String\ngamma = "λ→😀"\n',
      "-- NOTE: keep checking\n",
      "delta y = let z = beta y 2 in z * y\n",
    ];

    let state = EditorState.create({
      doc: `module Parity where\n\n${blocks.join("\n")}`,
      extensions: [treeSitterExtension("haskell")],
    });

    const editsToTry = [
      (s: EditorState) => {
        const text = s.doc.toString();
        const idx = text.indexOf("alpha a + b");
        return idx === -1 ? null : { from: idx + 6, to: idx + 7, insert: "b" };
      },
      (s: EditorState) => {
        const text = s.doc.toString();
        const idx = text.indexOf("TODO");
        return idx === -1
          ? { from: 0, to: 0, insert: "-- TODO: added\n" }
          : { from: idx, to: idx + 4, insert: "WARN" };
      },
      (s: EditorState) => {
        const line = s.doc.line(Math.min(s.doc.lines, 2 + nextInt(Math.max(1, s.doc.lines - 1))));
        return {
          from: line.from,
          to: line.from,
          insert: `fn${nextInt(999)} x = x + alpha x -- HINT: 😀\n`,
        };
      },
      (s: EditorState) => {
        const text = s.doc.toString();
        const idx = text.indexOf("WARN");
        return idx === -1 ? null : { from: idx, to: idx + 4, insert: "TODO" };
      },
      (s: EditorState) => {
        if (s.doc.lines < 5) return null;
        const first = s.doc.line(2);
        const last = s.doc.line(s.doc.lines - 1);
        return first.to < last.to
          ? [
              { from: first.to, to: first.to, insert: " -- NOTE: λ" },
              { from: last.to, to: last.to, insert: " -- FIXME: →" },
            ]
          : null;
      },
      (s: EditorState) => {
        if (s.doc.lines <= 6) return null;
        const line = s.doc.line(3 + nextInt(s.doc.lines - 4));
        return { from: line.from, to: Math.min(s.doc.length, line.to + 1), insert: "" };
      },
    ];

    for (let step = 0; step < 40; step++) {
      const makeChange = editsToTry[nextInt(editsToTry.length)];
      const changes = makeChange?.(state);
      if (!changes) continue;

      state = state.update({ changes }).state;
      const docText = state.doc.toString();
      const incremental = getSyntaxTree(state);
      expect(incremental).not.toBeNull();
      if (!incremental) continue;

      const fresh = SyntaxTree.parse(docText, "haskell");
      try {
        if (!fresh.tree().rootNode.hasError) {
          const incSpans = highlightRange(
            incremental.syntax,
            state.doc,
            0,
            docText.length,
            WORKSHOP_SYNTAX_SCOPES,
          );
          const freshSpans = highlightRange(
            fresh,
            docText,
            0,
            docText.length,
            WORKSHOP_SYNTAX_SCOPES,
          );
          expect(incSpans).toEqual(freshSpans);
        }
      } finally {
        fresh.delete();
      }
    }
  });

  it("keeps live WASM tree count bounded across 500 edits and stays sound on old EditorStates", () => {
    const initialDoc = [
      "module Leak where",
      "-- TODO: comment 1",
      "f x = x + 1",
      "-- FIXME: comment 2",
      "g y = f y * 2",
      "-- NOTE: comment 3",
      "",
    ].join("\n");

    const state0 = EditorState.create({
      doc: initialDoc,
      extensions: [treeSitterExtension("haskell")],
    });
    const snap0 = getSyntaxTree(state0);
    expect(snap0).not.toBeNull();
    if (snap0) {
      highlightRange(snap0.syntax, state0.doc, 0, state0.doc.length, WORKSHOP_SYNTAX_SCOPES);
    }

    const before = getTreeStats();
    let state = state0;
    const insertAt = initialDoc.indexOf("x + 1") + 5;

    for (let i = 0; i < 500; i++) {
      const deleting = i % 2 === 1;
      state = state.update({
        changes: deleting
          ? { from: insertAt, to: insertAt + 4, insert: "" }
          : { from: insertAt, to: insertAt, insert: " + 1" },
      }).state;

      const snap = getSyntaxTree(state);
      expect(snap).not.toBeNull();
      if (snap) {
        highlightRange(snap.syntax, state.doc, 0, state.doc.length, WORKSHOP_SYNTAX_SCOPES);
      }
    }

    const after = getTreeStats();
    // Every edit creates a new root tree (and shifted moved comment trees), while the 2-slot pool
    // evicts and deletes superseded snapshots immediately so live count stays bounded.
    expect(after.created - before.created).toBeGreaterThanOrEqual(500);
    expect(after.deleted - before.deleted).toBeGreaterThanOrEqual(498);
    expect(after.live - before.live).toBeLessThanOrEqual(16);

    // Reading an already-evicted old EditorState transparently re-parses without use-after-free.
    const oldSnap = getSyntaxTree(state0);
    expect(oldSnap).not.toBeNull();
    if (oldSnap) {
      const spans = highlightRange(
        oldSnap.syntax,
        state0.doc,
        0,
        state0.doc.length,
        WORKSHOP_SYNTAX_SCOPES,
      );
      expect(spans.some((s) => state0.doc.sliceString(s.from, s.to) === "TODO")).toBe(true);
      oldSnap.syntax.delete();
    }
  });
});

describe("capture precedence, locals, and injections", () => {
  function tokenScopes(code: string): { text: string; scopes: readonly string[] }[] {
    const syntax = SyntaxTree.parse(code, "haskell");
    try {
      return highlightRange(syntax, code, 0, code.length, WORKSHOP_SYNTAX_SCOPES).map((s) => ({
        text: code.slice(s.from, s.to),
        scopes: s.scopes,
      }));
    } finally {
      syntax.delete();
    }
  }

  it("resolves local parameter and function references via locals.scm", () => {
    const tokens = tokenScopes("add x y = x + y\n");
    const xs = tokens.filter((t) => t.text === "x");
    const ys = tokens.filter((t) => t.text === "y");
    expect(xs).toEqual([
      { text: "x", scopes: ["variable.parameter"] },
      { text: "x", scopes: ["variable.parameter"] },
    ]);
    expect(ys).toEqual([
      { text: "y", scopes: ["variable.parameter"] },
      { text: "y", scopes: ["variable.parameter"] },
    ]);
  });

  it("applies later-pattern precedence for booleans, main, exceptions, and debug helpers", () => {
    const tokens = tokenScopes('main = if True then error "boom" else traceShowId otherwise\n');
    const byText = (word: string) => tokens.find((t) => t.text === word)?.scopes;
    expect(byText("main")).toEqual(["function"]);
    expect(byText("True")).toEqual(["constant.builtin"]);
    expect(byText("error")).toEqual(["keyword.exception"]);
    expect(byText("traceShowId")).toEqual(["keyword.debug"]);
    expect(byText("otherwise")).toEqual(["constant.builtin"]);
  });

  it("stacks comment injection highlights on top of comment and silently skips unshipped injections", () => {
    const tokens = tokenScopes("-- TODO: check FIXME\nx = [sql|SELECT 1|]\n");
    expect(tokens.find((t) => t.text === "TODO")?.scopes).toEqual(["comment", "info"]);
    expect(tokens.find((t) => t.text === "FIXME")?.scopes).toEqual(["comment", "error"]);
    // `sql` grammar isn't shipped, so its quasiquote body produces no injected highlights.
    expect(tokens.some((t) => t.text.includes("SELECT"))).toBe(false);
  });

  it("builds nested CodeMirror decorations preserving highlight stack order", () => {
    const spans: HighlightSpan[] = [
      { from: 0, to: 3, scopes: ["comment"] },
      { from: 3, to: 7, scopes: ["comment", "info"] },
      { from: 7, to: 12, scopes: ["comment"] },
    ];
    const decos = buildHighlightDecorations(spans);
    const collected: { from: number; to: number; cls: string }[] = [];
    decos.between(0, 12, (from, to, value) => {
      collected.push({ from, to, cls: (value.spec as { class: string }).class });
    });
    expect(collected).toEqual([
      { from: 0, to: 12, cls: "ts-hl syntax-comment" },
      { from: 3, to: 7, cls: "ts-hl syntax-info" },
    ]);
  });
});

describe("Helix tree-house golden parity", () => {
  // `fixtures/haskell.golden.json` was produced by running Helix's `tree-house` 0.4.0 crate
  // directly against Helix's `runtime/grammars/{haskell,comment}.dylib` and
  // `runtime/queries/{haskell,comment}/*.scm` at commit 18dbe190a0139f6c74320059146b2413b82b011c.
  it("matches Helix tree-house 0.4.0 output on every span of fixtures/haskell.hs", () => {
    const syntax = SyntaxTree.parse(GOLDEN_SOURCE, "haskell");
    try {
      const actual: GoldenSpan[] = highlightRange(
        syntax,
        GOLDEN_SOURCE,
        0,
        GOLDEN_SOURCE.length,
        WORKSHOP_SYNTAX_SCOPES,
      ).map((span) => ({
        from: span.from,
        to: span.to,
        text: GOLDEN_SOURCE.slice(span.from, span.to),
        scopes: [...span.scopes],
      }));

      expect(actual).toEqual(GOLDEN_SPANS);
    } finally {
      syntax.delete();
    }
  });

  it("produces identical highlights when restricted to a middle viewport slice", () => {
    const syntax = SyntaxTree.parse(GOLDEN_SOURCE, "haskell");
    try {
      const sliceStart = GOLDEN_SOURCE.indexOf("{- Block comment");
      const sliceEnd = GOLDEN_SOURCE.indexOf("compose ::");
      const sliced = highlightRange(
        syntax,
        GOLDEN_SOURCE,
        sliceStart,
        sliceEnd,
        WORKSHOP_SYNTAX_SCOPES,
      );
      const expected = GOLDEN_SPANS.filter((s) => s.to > sliceStart && s.from < sliceEnd).map(
        (s) => ({
          from: Math.max(s.from, sliceStart),
          to: Math.min(s.to, sliceEnd),
          scopes: s.scopes,
        }),
      );
      expect(sliced).toEqual(expected);
    } finally {
      syntax.delete();
    }
  });
});

describe("Haskell parse and highlight performance", () => {
  function makeBenchDoc(blockCount: number): string {
    const blocks: string[] = ["module Perf where\n"];
    for (let i = 0; i < blockCount; i++) {
      blocks.push(
        `-- TODO: benchmark block ${i} (#${i})\n` +
          `data Record${i} = Record${i} { fieldA${i} :: Int, fieldB${i} :: String }\n` +
          `  deriving (Eq, Show)\n` +
          `compute${i} :: Record${i} -> [Int] -> Int\n` +
          `compute${i} (Record${i} a _) xs =\n` +
          `  let ys = map (\\n -> n * 2 + a) xs\n` +
          `      zs = (+ 1) <$> ys\n` +
          `   in if null zs then 0 else sum zs + ${i}\n` +
          `helper${i} :: Int -> Int\n` +
          `helper${i} k = compute${i} (Record${i} k "hi") [1, 2, 3]\n`,
      );
    }
    return blocks.join("");
  }

  function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)] ?? 0;
  }

  it("parses, incrementally edits, and highlights 100-line and 1000-line Haskell files quickly", () => {
    const doc100 = makeBenchDoc(10);
    const doc1000 = makeBenchDoc(100);
    expect(doc1000.split("\n").length - 1).toBeGreaterThanOrEqual(1000);

    // Measure 100-line incremental edits (warmed up).
    let state100 = EditorState.create({
      doc: doc100,
      extensions: [treeSitterExtension("haskell")],
    });
    const pos100 = doc100.indexOf("compute5 (Record5 a _) xs =") + 10;
    const edit100Times: number[] = [];
    for (let i = 0; i < 12; i++) {
      const del = i % 2 === 1;
      const t = performance.now();
      state100 = state100.update({
        changes: del
          ? { from: pos100, to: pos100 + 1, insert: "" }
          : { from: pos100, to: pos100, insert: " " },
      }).state;
      const dt = performance.now() - t;
      if (i >= 2) edit100Times.push(dt);
    }
    const incremental100Ms = median(edit100Times);

    // Measure 1000-line initial parse, incremental edit, and 100-line viewport highlight.
    const t0 = performance.now();
    let state1000 = EditorState.create({
      doc: doc1000,
      extensions: [treeSitterExtension("haskell")],
    });
    const initial1000Ms = performance.now() - t0;

    const vpStart = state1000.doc.line(451).from;
    const vpEnd = state1000.doc.line(550).to;

    const hlTimes: number[] = [];
    let spanCount = 0;
    for (let i = 0; i < 12; i++) {
      const snap = getSyntaxTree(state1000);
      expect(snap).not.toBeNull();
      if (!snap) break;
      const t = performance.now();
      const spans = highlightRange(
        snap.syntax,
        state1000.doc,
        vpStart,
        vpEnd,
        WORKSHOP_SYNTAX_SCOPES,
      );
      const dt = performance.now() - t;
      spanCount = spans.length;
      if (i >= 2) hlTimes.push(dt);
    }
    expect(spanCount).toBeGreaterThan(100);
    const viewportHighlightMs = median(hlTimes);

    const pos1000 = doc1000.indexOf("compute50 (Record50 a _) xs =") + 10;
    const edit1000Times: number[] = [];
    const postEditHlTimes: number[] = [];
    for (let i = 0; i < 12; i++) {
      const del = i % 2 === 1;
      const tEdit = performance.now();
      state1000 = state1000.update({
        changes: del
          ? { from: pos1000, to: pos1000 + 1, insert: "" }
          : { from: pos1000, to: pos1000, insert: " " },
      }).state;
      const dtEdit = performance.now() - tEdit;

      const snap = getSyntaxTree(state1000);
      expect(snap).not.toBeNull();
      const tHl = performance.now();
      if (snap) {
        highlightRange(snap.syntax, state1000.doc, vpStart, vpEnd, WORKSHOP_SYNTAX_SCOPES);
      }
      const dtHl = performance.now() - tHl;
      if (i >= 2) {
        edit1000Times.push(dtEdit);
        postEditHlTimes.push(dtHl);
      }
    }
    const incremental1000Ms = median(edit1000Times);
    const postEditHighlightMs = median(postEditHlTimes);

    console.info(
      `[treesitter perf] 100L incrementalEdit=${incremental100Ms.toFixed(2)}ms | ` +
        `1001L initialParse=${initial1000Ms.toFixed(1)}ms, ` +
        `incrementalEdit=${incremental1000Ms.toFixed(2)}ms, ` +
        `viewportHighlight=${viewportHighlightMs.toFixed(2)}ms, ` +
        `postEditHighlight=${postEditHighlightMs.toFixed(2)}ms`,
    );

    expect(incremental100Ms).toBeLessThan(2);
    expect(viewportHighlightMs).toBeLessThan(5);
    expect(postEditHighlightMs).toBeLessThan(5);
    expect(incremental1000Ms).toBeLessThan(15);
  });
});
