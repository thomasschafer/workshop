import { beforeAll, describe, expect, it } from "vitest";
import { highlightedHtml, resolveSyntaxMode } from "./syntax";
import { loadLanguageBundle, registeredTreeSitterModes } from "./treesitter";
import { installNodeWasmLoader } from "./treesitter/nodeTestLoader";

beforeAll(async () => {
  installNodeWasmLoader();
  await Promise.all(registeredTreeSitterModes().map((mode) => loadLanguageBundle(mode)));
});

describe("highlightedHtml", () => {
  it("highlights each language by the name its code block is marked with", () => {
    for (const [marked, code, keyword] of <[string, string, string][]>[
      ["python", "def f(x):\n    return x", "def"],
      ["py", "def f(x):\n    return x", "def"],
      ["typescript", "export function f(x: number): number { return x; }", "export"],
      ["ts", "const x: number = 1;", "const"],
      ["go", "package main\nfunc main() { return }", "func"],
      ["rust", "fn main() { let x = 1; }", "fn"],
      ["rs", "fn main() { let x = 1; }", "let"],
      ["cpp", "int main() { return 0; }", "return"],
      ["c++", "int main() { return 0; }", "return"],
      ["haskell", "main = do\n  let x = 1\n  print x", "let"],
      ["hs", "data Colour = Red | Green", "data"],
    ]) {
      expect(highlightedHtml(code, marked), marked).toContain(
        `<span class="ts-hl syntax-keyword">${keyword}</span>`,
      );
    }
    expect(highlightedHtml('s = "hi"  # note', "python")).toContain(
      '<span class="ts-hl syntax-string">"hi"</span>',
    );
    expect(highlightedHtml("x = 1  # note", "python")).toContain(
      '<span class="ts-hl syntax-comment"># note</span>',
    );
  });

  it("highlights injected spans (such as comment tags) with nested classes", () => {
    const html = highlightedHtml("# TODO: check this\n", "python") ?? "";
    expect(html).toContain('<span class="ts-hl syntax-comment">');
    expect(html).toContain('<span class="ts-hl syntax-info">TODO</span>');
  });

  it("keeps the code's text, escaped, and its lines", () => {
    const html = highlightedHtml("#include <vector>\nint a = 1 < 2 && 3 > 2;\n", "cpp") ?? "";
    expect(html).not.toContain("<vector>");
    expect(html.replace(/<[^>]+>/g, "")).toBe(
      "#include &lt;vector&gt;\nint a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;\n",
    );
  });

  it("leaves code in other languages alone", () => {
    expect(resolveSyntaxMode("sql")).toBeNull();
    expect(highlightedHtml("SELECT 1", "sql")).toBeNull();
  });
});
