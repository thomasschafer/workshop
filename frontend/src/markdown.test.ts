import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

describe("renderMarkdown", () => {
  it("formats what coaches write", () => {
    const html = renderMarkdown(
      "Some **clues**:\n\n1. Look at `seen`.\n2. Try *this*.\n\n```haskell\nmain = pure ()\n```",
    );
    expect(html).toContain("<strong>clues</strong>");
    expect(html).toContain("<ol>");
    expect(html).toContain("<code>seen</code>");
    expect(html).toContain("<em>this</em>");
    expect(html).toContain('<pre><code class="language-haskell">');
    expect(html.replace(/<[^>]+>/g, "")).toContain("main = pure ()");
  });

  it("highlights code blocks for the language they're marked with", () => {
    const html = renderMarkdown(
      'What does this print?\n\n```rust\nfn main() {\n    println!("a < b");\n}\n```\n',
    );
    expect(html).toContain(
      '<pre><code class="language-rust"><span class="syntax-keyword">fn</span>',
    );
    expect(html).toContain("&lt;");
    expect(html).not.toContain("a < b");
    const plain = renderMarkdown("```text\na < b\n```");
    expect(plain).toContain('<pre><code class="language-text">a &lt; b\n</code></pre>');
  });

  it("escapes raw HTML", () => {
    const html = renderMarkdown('Hi <script>alert(1)</script> <img src=x onerror="alert(1)">');
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;");
  });

  it("drops links with unsafe protocols", () => {
    const html = renderMarkdown(
      "[click](javascript:alert(1)) and [docs](https://hackage.haskell.org)",
    );
    expect(html).not.toContain("javascript:");
    expect(html).toContain('href="https://hackage.haskell.org"');
  });
});
