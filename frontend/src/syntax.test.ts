import { describe, expect, it } from "vitest";
import { highlightedHtml } from "./syntax";

describe("highlightedHtml", () => {
  it("highlights each language by the name its code block is marked with", () => {
    for (const [marked, code, keyword] of <[string, string, string][]>[
      ["python", "def f(x):\n    return x", "def"],
      ["py", "def f(x):\n    return x", "def"],
      ["rust", "fn main() { let x = 1; }", "fn"],
      ["rs", "fn main() { let x = 1; }", "let"],
      ["cpp", "int main() { return 0; }", "return"],
      ["c++", "int main() { return 0; }", "return"],
    ]) {
      expect(highlightedHtml(code, marked), marked).toContain(
        `<span class="syntax-keyword">${keyword}</span>`,
      );
    }
    expect(highlightedHtml('s = "hi"  # note', "python")).toContain(
      '<span class="syntax-string">"hi"</span>',
    );
    expect(highlightedHtml("x = 1  # note", "python")).toContain(
      '<span class="syntax-comment"># note</span>',
    );
  });

  it("keeps the code's text, escaped, and its lines", () => {
    const html = highlightedHtml("#include <vector>\nint a = 1 < 2 && 3 > 2;\n", "cpp") ?? "";
    expect(html).not.toContain("<vector>");
    expect(html.replace(/<[^>]+>/g, "")).toBe(
      "#include &lt;vector&gt;\nint a = 1 &lt; 2 &amp;&amp; 3 &gt; 2;\n",
    );
  });

  it("leaves code in other languages alone", () => {
    expect(highlightedHtml("SELECT 1", "sql")).toBeNull();
  });
});
