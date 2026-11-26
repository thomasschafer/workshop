import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { Query } from "web-tree-sitter";
import { getLoadedLanguageBundle, loadLanguageBundle, setWasmBytesLoader } from "../treesitter";
import { helixSettings } from "./config";
import { DEFAULT_OPTIONS, IndentStyleKind } from "./editor";
import { compileIndentQuery, indentForNewline } from "./indent";
import { collectSyntaxTags } from "./tags";
import { harness } from "./testing";
import { Doc } from "./text";

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

describe("syntax_symbol_picker and lsp_or_syntax_symbol_picker", () => {
  const SAMPLE = [
    "module Demo where",
    "",
    "type Alias = Int",
    "newtype UserId = UserId Int",
    "data Point = Point Int Int",
    "class Showable a where",
    "  display :: a -> String",
    "add :: Int -> Int -> Int",
    "add x y = x + y",
    "",
  ].join("\n");

  it("extracts Haskell symbols from tags.scm and jumps via the picker", async () => {
    const h = harness(`#[m|]#${SAMPLE.slice(1)}`, { lang: "haskell" });
    try {
      const syntax = h.editor.syntax;
      expect(syntax).not.toBeNull();
      if (syntax === null) return;
      const tags = collectSyntaxTags(syntax, h.editor.doc);
      expect(tags.map((t) => [t.kind, t.name])).toEqual([
        ["module", "Demo"],
        ["type", "Alias"],
        ["struct", "UserId"],
        ["struct", "Point"],
        ["interface", "Showable"],
        ["function", "display"],
        ["function", "add"],
        ["function", "add"],
      ]);

      // <space>s runs lsp_or_syntax_symbol_picker, which falls back to syntax_symbol_picker when
      // no LSP documentSymbolProvider is running.
      await h.keys("<space>s");
      expect(h.editor.picker).not.toBeNull();
      expect(h.editor.picker?.title).toBe("Symbols");
      expect(h.editor.picker?.items.map((item) => item.label)).toContain("Point");

      // Filter to Point and accept.
      await h.keys("Point<ret>");
      expect(h.editor.picker).toBeNull();
      expect(h.editor.selection.primary.fragment(h.editor.doc)).toBe("data Point = Point Int Int");
    } finally {
      h.dispose();
    }
  });

  it("prefers LSP symbol_picker when the host advertises documentSymbolProvider", async () => {
    const h = harness(`#[m|]#${SAMPLE.slice(1)}`, { lang: "haskell" });
    try {
      h.host.lspDocumentSymbols = true;
      await h.keys("<space>s");
      expect(h.host.actions).toEqual(["symbol_picker"]);
      expect(h.editor.picker).toBeNull();
    } finally {
      h.dispose();
    }
  });

  it("reports Helix's error messages when no syntax tree or LSP is available", async () => {
    const h = harness("#[a|]#bc\n");
    await h.keys("<space>s");
    expect(h.editor.status?.severity).toBe("error");
    expect(h.editor.status?.message).toBe(
      "No language server supporting document symbols or syntax info available",
    );
  });
});

describe("smart_tab config and options", () => {
  it("defaults to enable=true and supersedeMenu=false like Helix", () => {
    expect(DEFAULT_OPTIONS.smartTab).toEqual({ enable: true, supersedeMenu: false });
    expect(helixSettings({}).options.smartTab).toEqual({ enable: true, supersedeMenu: false });
    expect(
      helixSettings({ "smart-tab": { enable: false, "supersede-menu": true } }).options.smartTab,
    ).toEqual({ enable: false, supersedeMenu: true });
    expect(helixSettings({ "smart-tab": { "supersede-menu": true } }).options.smartTab).toEqual({
      enable: true,
      supersedeMenu: true,
    });
  });

  it("inserts a tab when smart-tab.enable is false via :set", async () => {
    const h = harness("f x = (#[a|]# + b)\n", { lang: "haskell" });
    try {
      await h.keys(":set smart-tab.enable false<ret>");
      expect(h.editor.options.smartTab.enable).toBe(false);
      await h.keys("a<tab><esc>");
      expect(h.host.state.doc.toString()).toBe("f x = (a   + b)\n");

      await h.keys(":set smart-tab.supersede-menu true<ret>");
      expect(h.editor.options.smartTab.supersedeMenu).toBe(true);
    } finally {
      h.dispose();
    }
  });
});

describe("no-tree graceful fallbacks", () => {
  it("never throws and keeps Helix's plaintext fallbacks when no tree is loaded", async () => {
    const h = harness("foo (#[b|]#ar)\n");
    await h.keys("<A-o><A-i><A-n><A-p><A-a><A-I><A-e><A-b>");
    expect(h.state()).toBe("foo (#[b|]#ar)\n");

    await h.keys("mif");
    expect(h.editor.status?.message).toBe("Syntax information is not available in current buffer");
    await h.keys("]f");
    expect(h.editor.status?.message).toBe("Syntax-tree is not available in current buffer");

    // Plaintext bracket matching (`mm` only matches when directly on a bracket, matching Helix)
    await h.keys("mm");
    expect(h.state()).toBe("foo (#[b|]#ar)\n");
    await h.keys("hmm");
    expect(h.state()).toBe("foo (bar#[)|]#\n");

    // Plaintext closest-pair surround still works without a tree
    await h.keys("hmim");
    expect(h.state()).toBe("foo (#[bar|]#)\n");
  });
});

describe("tree-sitter indentation engine (indents.scm + hybrid heuristic)", () => {
  it("evaluates @indent, @outdent, @align/@anchor, @extend, @opaque, header scope, predicates, and hybrid baseline", () => {
    const bundle = getLoadedLanguageBundle("haskell");
    expect(bundle).not.toBeNull();
    if (bundle === null) return;

    const indentQuerySrc = `
      (do) @indent
      (tuple) @indent
      (list) @indent
      ((list "]" @outdent))
      (parens "(" @anchor) @align
      (string) @opaque
      ((function) @indent (#not-one-line? @indent))
      ((expression/apply) @indent (#not-kind-eq? @indent "variable"))
      ((local_binds) @extend)
    `;
    const compiled = compileIndentQuery(new Query(bundle.language, indentQuerySrc));
    const spaces2 = { kind: IndentStyleKind.Spaces as const, n: 2 };

    // Inside a multiline do block: @indent adds 1 level relative to the opening line.
    const doCode = "f = do\n  x\n  y\n";
    const h1 = harness(`#[f|]#${doCode.slice(1)}`, { lang: "haskell" });
    try {
      const syntax = h1.editor.syntax;
      if (syntax === null) throw new Error("expected syntax");
      const doc = Doc.of(doCode);
      expect(
        indentForNewline(syntax, spaces2, 2, doc, 0, doc.lineEnd(0), 0, "hybrid", compiled),
      ).toBe("  ");
      expect(
        indentForNewline(syntax, spaces2, 2, doc, 1, doc.lineEnd(1), 1, "hybrid", compiled),
      ).toBe("  ");
    } finally {
      h1.dispose();
    }

    // Hybrid heuristic adapts to a user's existing 4-space indentation on the previous line.
    const customIndentCode = "    f = do\n      x\n      y\n";
    const h2 = harness(`#[ |]#${customIndentCode.slice(1)}`, { lang: "haskell" });
    try {
      const syntax = h2.editor.syntax;
      if (syntax === null) throw new Error("expected syntax");
      const doc = Doc.of(customIndentCode);
      expect(
        indentForNewline(syntax, spaces2, 2, doc, 0, doc.lineEnd(0), 0, "hybrid", compiled),
      ).toBe("      ");
    } finally {
      h2.dispose();
    }

    // @align + @anchor aligns continuation lines to the opening paren column.
    const alignCode = "f = (1 +\n2)\n";
    const h3 = harness(`#[f|]#${alignCode.slice(1)}`, { lang: "haskell" });
    try {
      const syntax = h3.editor.syntax;
      if (syntax === null) throw new Error("expected syntax");
      const doc = Doc.of(alignCode);
      expect(
        indentForNewline(syntax, spaces2, 2, doc, 0, doc.lineEnd(0), 0, "tree-sitter", compiled),
      ).toBe("    ");
    } finally {
      h3.dispose();
    }

    // @opaque preserves existing leading whitespace inside a multiline string literal.
    const opaqueCode = 's = "hello\\\n   \\world"\n';
    const h4 = harness(`#[s|]#${opaqueCode.slice(1)}`, { lang: "haskell" });
    try {
      const syntax = h4.editor.syntax;
      if (syntax === null) throw new Error("expected syntax");
      const doc = Doc.of(opaqueCode);
      expect(
        indentForNewline(
          syntax,
          spaces2,
          2,
          doc,
          1,
          doc.lineStart(1) + 4,
          1,
          "tree-sitter",
          compiled,
        ),
      ).toBe("   ");
    } finally {
      h4.dispose();
    }

    // Fails loudly on unknown scope or unknown predicate in indents.scm.
    expect(() =>
      compileIndentQuery(new Query(bundle.language, '((do) @indent (#set! scope "bogus"))')),
    ).toThrow(/unknown scope/);
    expect(() =>
      compileIndentQuery(new Query(bundle.language, "((do) @indent (#unknown-pred? @indent))")),
    ).toThrow(/unknown predicate/);
  });
});
