import { micromark } from "micromark";
import { gfm, gfmHtml } from "micromark-extension-gfm";

/**
 * Renders a model's markdown reply as HTML. Raw HTML in the reply is escaped and links with
 * unsafe protocols are dropped, so the result is safe to insert into the page.
 */
export function renderMarkdown(text: string): string {
  return micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
}
