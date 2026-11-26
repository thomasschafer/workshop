import type { ResolvedSyntaxThemes } from "./api";
import { buildHelixSyntaxCss, setActiveSyntaxThemes } from "./treesitter/theme";

/** Applies a terminal theme's colours over Workshop's own, or removes them for `null`. */
export function applyThemeCss(css: string | null): void {
  let style = document.getElementById("workshop-theme");
  if (css === null) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "workshop-theme";
    document.head.append(style);
  }
  style.textContent = css;
}

/** Applies Helix syntax theme colours over Workshop's defaults, or clears them when unset. */
export function applySyntaxTheme(themes: ResolvedSyntaxThemes | null | undefined): void {
  const normalized = themes ?? null;
  setActiveSyntaxThemes(normalized);
  const css = buildHelixSyntaxCss(normalized);
  let style = document.getElementById("workshop-syntax-theme");
  if (css === null) {
    style?.remove();
    return;
  }
  if (!style) {
    style = document.createElement("style");
    style.id = "workshop-syntax-theme";
    document.head.append(style);
  }
  style.textContent = css;
}
