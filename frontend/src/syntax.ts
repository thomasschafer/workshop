import {
  activeSyntaxScopeSet,
  getLoadedLanguageBundle,
  type HighlightSpan,
  hasTreeSitterMode,
  highlightRange,
  loadLanguageBundle,
  onLanguageBundleLoaded,
  onSyntaxThemeChange,
  SyntaxTree,
  scopeToClass,
} from "./treesitter";

/** Other names a Markdown code block can be marked with, as packs' reading items allow. */
const ALIASES: Readonly<Record<string, string>> = {
  py: "python",
  rs: "rust",
  "c++": "cpp",
  hs: "haskell",
  ts: "typescript",
};

/** Maps a Markdown code fence language marker to a registered tree-sitter mode, or null. */
export function resolveSyntaxMode(marked: string): string | null {
  const normalized = marked.trim().toLowerCase();
  const mode = ALIASES[normalized] ?? normalized;
  return hasTreeSitterMode(mode) ? mode : null;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Renders stacked `HighlightSpan`s as nested `<span class="ts-hl syntax-...">` HTML with all
 * code text escaped, preserving outer-to-inner scope cascade order identically to the editor.
 */
function renderSpansHtml(code: string, spans: readonly HighlightSpan[]): string {
  let html = "";
  let pos = 0;
  const open: string[] = [];

  const closeTo = (depth: number): void => {
    while (open.length > depth) {
      open.pop();
      html += "</span>";
    }
  };

  for (const span of spans) {
    if (span.from > pos) {
      closeTo(0);
      html += escapeHtml(code.slice(pos, span.from));
      pos = span.from;
    }
    let common = 0;
    while (
      common < open.length &&
      common < span.scopes.length &&
      open[common] === span.scopes[common]
    ) {
      common++;
    }
    closeTo(common);
    for (let d = common; d < span.scopes.length; d++) {
      const scope = span.scopes[d];
      if (!scope) continue;
      open.push(scope);
      html += `<span class="ts-hl ${scopeToClass(scope)}">`;
    }
    html += escapeHtml(code.slice(span.from, span.to));
    pos = span.to;
  }

  closeTo(0);
  if (pos < code.length) {
    html += escapeHtml(code.slice(pos));
  }
  return html;
}

/**
 * Code as HTML, its text escaped and highlighted with tree-sitter and Helix's queries for the
 * language a Markdown code block is marked with, or null if the language is unsupported or its
 * grammar hasn't finished loading yet (in which case loading is started in the background).
 */
export function highlightedHtml(code: string, marked: string): string | null {
  const mode = resolveSyntaxMode(marked);
  if (mode === null) return null;

  if (getLoadedLanguageBundle(mode) === null) {
    void loadLanguageBundle(mode).catch((error: unknown) => {
      console.error(`[syntax] failed to load ${mode} grammar:`, error);
    });
    return null;
  }

  const syntax = SyntaxTree.parse(code, mode);
  try {
    const spans = highlightRange(syntax, code, 0, code.length, activeSyntaxScopeSet());
    return renderSpansHtml(code, spans);
  } finally {
    syntax.delete();
  }
}

/**
 * Subscribes to events that affect `highlightedHtml` output: a grammar finishing loading or the
 * active Helix syntax theme / colour scheme changing. Returns an unsubscribe function.
 */
export function onSyntaxHighlightUpdate(listener: () => void): () => void {
  const offBundle = onLanguageBundleLoaded(() => listener());
  const offTheme = onSyntaxThemeChange(listener);
  return () => {
    offBundle();
    offTheme();
  };
}
