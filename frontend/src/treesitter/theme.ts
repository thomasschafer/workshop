import type { HelixSyntaxScopes, ResolvedSyntaxThemes, SyntaxScopeStyle } from "../api";

/**
 * Helix highlight scopes styled by Workshop's built-in light and dark themes in `styles.css`.
 * Captures resolve against this set using Helix's fallback rule when no Helix theme is active.
 */
export const WORKSHOP_SYNTAX_SCOPES: ReadonlySet<string> = new Set([
  "keyword",
  "keyword.directive",
  "keyword.exception",
  "keyword.debug",
  "function",
  "type",
  "constructor",
  "variable",
  "variable.parameter",
  "variable.other.member",
  "string",
  "string.special.symbol",
  "constant",
  "constant.numeric",
  "constant.character",
  "constant.builtin",
  "operator",
  "punctuation",
  "comment",
  "comment.documentation",
  "namespace",
  "label",
  "special",
  "attribute",
  "tag",
  "markup.link.url",
  "hint",
  "info",
  "warning",
  "error",
]);

/**
 * Maps a Helix capture name to the most specific scope defined in `knownScopes`, following
 * `helix-view`'s `Theme::find_highlight`: try the exact capture name, then strip trailing
 * `.segment`s until a match is found or nothing remains.
 */
export function resolveScope(capture: string, knownScopes: ReadonlySet<string>): string | null {
  let scope = capture;
  for (;;) {
    if (knownScopes.has(scope)) return scope;
    const dot = scope.lastIndexOf(".");
    if (dot === -1) return null;
    scope = scope.slice(0, dot);
  }
}

/**
 * CSS class name for a resolved Helix scope, e.g. `"keyword"` -> `"syntax-keyword"` and
 * `"variable.parameter"` -> `"syntax-variable-parameter"`.
 */
export function scopeToClass(scope: string): string {
  const safe = scope.replace(/[^A-Za-z0-9_-]/g, "-");
  return `syntax-${safe}`;
}

function styleToCssDecls(style: SyntaxScopeStyle): string {
  const decls: string[] = [];
  if (style.fg) {
    decls.push(`color:${style.fg};`);
  }
  const mods = style.modifiers ?? [];
  if (mods.includes("bold")) decls.push("font-weight:700;");
  if (mods.includes("italic")) decls.push("font-style:italic;");
  const underlined = mods.includes("underlined");
  const crossedOut = mods.includes("crossed_out");
  if (underlined && crossedOut) {
    decls.push("text-decoration:underline line-through;");
  } else if (underlined) {
    decls.push("text-decoration:underline;");
  } else if (crossedOut) {
    decls.push("text-decoration:line-through;");
  }
  if (mods.includes("dim")) decls.push("opacity:0.65;");
  return decls.join("");
}

function schemeCss(scheme: "light" | "dark", scopes: HelixSyntaxScopes): string {
  const rules: string[] = [
    // Clear Workshop's default `.syntax-*` rules inside the editor and Markdown code blocks so a
    // Helix theme's absence of italic (e.g. on comments) isn't overridden by `styles.css`.
    ".cm-content .ts-hl,.markdown .ts-hl{color:inherit;font-style:inherit;font-weight:inherit;text-decoration:none;}",
  ];
  for (const [scope, style] of Object.entries(scopes)) {
    const decls = styleToCssDecls(style);
    if (!decls) continue;
    const cls = scopeToClass(scope);
    rules.push(`.cm-content .ts-hl.${cls},.markdown .ts-hl.${cls}{${decls}}`);
  }
  return `@media (prefers-color-scheme: ${scheme}) {\n${rules.join("\n")}\n}`;
}

/** Generates CSS rules applying resolved Helix syntax themes for light and/or dark mode. */
export function buildHelixSyntaxCss(themes: ResolvedSyntaxThemes | null): string | null {
  if (!themes) return null;
  const blocks: string[] = [];
  if (themes.light) blocks.push(schemeCss("light", themes.light));
  if (themes.dark) blocks.push(schemeCss("dark", themes.dark));
  return blocks.length > 0 ? blocks.join("\n") : null;
}

type ThemeListener = () => void;

let activeSyntaxThemes: ResolvedSyntaxThemes | null = null;
const listeners = new Set<ThemeListener>();
let mediaBound = false;

function isDarkMode(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

function notifyListeners(): void {
  for (const listener of listeners) listener();
}

function ensureMediaListener(): void {
  if (mediaBound || typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return;
  }
  mediaBound = true;
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", notifyListeners);
}

/** Updates the active Helix syntax themes and notifies open editors to refresh highlights. */
export function setActiveSyntaxThemes(themes: ResolvedSyntaxThemes | null): void {
  activeSyntaxThemes = themes;
  notifyListeners();
}

/** Returns the scope set used to resolve tree-sitter captures for the active colour scheme. */
export function activeSyntaxScopeSet(): ReadonlySet<string> {
  const scopes = isDarkMode() ? activeSyntaxThemes?.dark : activeSyntaxThemes?.light;
  if (!scopes) return WORKSHOP_SYNTAX_SCOPES;
  return new Set(Object.keys(scopes));
}

/** Subscribes to syntax theme or light/dark colour scheme changes. Returns an unsubscribe fn. */
export function onSyntaxThemeChange(listener: ThemeListener): () => void {
  ensureMediaListener();
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
