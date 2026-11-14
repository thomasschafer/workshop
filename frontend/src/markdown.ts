import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";
import { highlightedHtml } from "./syntax";

/** A code block as micromark writes it, marked with a language. Its text is escaped. */
const CODE_BLOCK = /<pre><code class="language-([^"]+)">([\s\S]*?)<\/code><\/pre>/g;

function unescapeHtml(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&");
}

/**
 * Renders a model's or a pack's markdown as HTML, with code blocks highlighted for the language
 * they're marked with. Raw HTML in the text is escaped and links with unsafe protocols are
 * dropped, so the result is safe to insert into the page.
 */
export function renderMarkdown(text: string): string {
  const html = micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  return html.replace(CODE_BLOCK, (block, marked: string, code: string) => {
    const highlighted = highlightedHtml(unescapeHtml(code), unescapeHtml(marked));
    return highlighted === null
      ? block
      : `<pre><code class="language-${marked}">${highlighted}</code></pre>`;
  });
}
