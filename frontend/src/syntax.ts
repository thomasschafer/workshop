import { StreamLanguage } from "@codemirror/language";
import { cpp } from "@codemirror/legacy-modes/mode/clike";
import { go } from "@codemirror/legacy-modes/mode/go";
import { haskell } from "@codemirror/legacy-modes/mode/haskell";
import { typescript } from "@codemirror/legacy-modes/mode/javascript";
import { python } from "@codemirror/legacy-modes/mode/python";
import { rust } from "@codemirror/legacy-modes/mode/rust";
import { highlightCode, tagHighlighter, tags } from "@lezer/highlight";

/** Syntax modes, by a language profile's `editor_mode`. */
export const LANGUAGES: Record<string, () => StreamLanguage<unknown>> = {
  haskell: () => StreamLanguage.define(haskell),
  python: () => StreamLanguage.define(python),
  typescript: () => StreamLanguage.define(typescript),
  go: () => StreamLanguage.define(go),
  rust: () => StreamLanguage.define(rust),
  cpp: () => StreamLanguage.define(cpp),
};

/** Other names a Markdown code block can be marked with, as packs' reading items allow. */
const ALIASES: Record<string, string> = {
  py: "python",
  rs: "rust",
  "c++": "cpp",
  ts: "typescript",
};

/** Classes for highlighted code, styled in styles.css, in the editor and in Markdown alike. */
export const syntaxHighlighter = tagHighlighter([
  { tag: [tags.keyword, tags.operatorKeyword, tags.controlKeyword], class: "syntax-keyword" },
  { tag: [tags.string, tags.character], class: "syntax-string" },
  { tag: [tags.number, tags.bool, tags.atom], class: "syntax-number" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], class: "syntax-comment" },
  { tag: [tags.typeName, tags.className], class: "syntax-type" },
  { tag: [tags.operator, tags.punctuation], class: "syntax-operator" },
]);

const parsers = new Map<string, StreamLanguage<unknown>>();

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Code as HTML, its text escaped and highlighted for the language a Markdown code block is
 * marked with, or null for a language there's no mode for.
 */
export function highlightedHtml(code: string, marked: string): string | null {
  const mode = ALIASES[marked] ?? marked;
  const define = LANGUAGES[mode];
  if (!define) return null;
  let language = parsers.get(mode);
  if (!language) {
    language = define();
    parsers.set(mode, language);
  }
  let html = "";
  highlightCode(
    code,
    language.parser.parse(code),
    syntaxHighlighter,
    (text, classes) => {
      html += classes ? `<span class="${classes}">${escapeHtml(text)}</span>` : escapeHtml(text);
    },
    () => {
      html += "\n";
    },
  );
  return html;
}
