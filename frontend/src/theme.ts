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
