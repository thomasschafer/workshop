// Rendering lesson segment Markdown with embedded SVGs (sanitised with DOMPurify's SVG profile
// so they inherit the theme's text colour through currentColor) and PNG data URLs.

import DOMPurify from "dompurify";
import type { DeckLessonImage } from "./types";

const SVG_SANITIZE_CONFIG = {
  USE_PROFILES: { svg: true, svgFilters: true },
  FORBID_TAGS: [
    "a",
    "script",
    "foreignObject",
    "animate",
    "set",
    "animateMotion",
    "animateTransform",
  ],
};

/** Sanitises an inline SVG string in the browser using DOMPurify's SVG profile. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, SVG_SANITIZE_CONFIG);
}

/** Whether a URL is an http or https link safe to open in a new tab. */
export function isSafeHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function lookupImage(
  images: Record<string, DeckLessonImage>,
  src: string,
): DeckLessonImage | undefined {
  return images[src] ?? images[safeDecode(src)];
}

/** True when `node` is the only meaningful child of its parent `<p>`. */
function isSoleParagraphChild(node: Element): boolean {
  const parent = node.parentElement;
  if (parent?.tagName !== "P") return false;
  for (const child of parent.childNodes) {
    if (child === node) continue;
    if (child.nodeType === Node.TEXT_NODE && (child.textContent ?? "").trim() === "") continue;
    return false;
  }
  return true;
}

/**
 * Populates `target` with rendered Markdown HTML, replacing `<img>` references with inline
 * DOMPurify-sanitised SVGs or embedded PNG data URLs before attaching to the live DOM so no
 * relative image paths are ever requested over the network.
 */
export function renderLessonHtmlInto(
  target: HTMLElement,
  markdownHtml: string,
  images: Record<string, DeckLessonImage>,
  sanitize: (svg: string) => string = sanitizeSvg,
): void {
  const doc = target.ownerDocument;
  const template = doc.createElement("template");
  template.innerHTML = markdownHtml;

  const imgs = Array.from(template.content.querySelectorAll("img"));
  for (const img of imgs) {
    const rawSrc = img.getAttribute("src") ?? "";
    const alt = img.getAttribute("alt") ?? "";
    const asset = lookupImage(images, rawSrc);
    const soleInP = isSoleParagraphChild(img);
    const replaceTarget = soleInP && img.parentElement ? img.parentElement : img;

    if (!asset) {
      const fallback = doc.createElement("span");
      fallback.className = "muted";
      fallback.textContent = alt;
      replaceTarget.replaceWith(fallback);
      continue;
    }

    if (asset.kind === "svg") {
      const clean = sanitize(asset.svg);
      const holder = doc.createElement("div");
      holder.innerHTML = clean;
      const svgEl = holder.querySelector("svg");
      if (!svgEl) {
        const fallback = doc.createElement("span");
        fallback.className = "muted";
        fallback.textContent = alt;
        replaceTarget.replaceWith(fallback);
        continue;
      }
      svgEl.setAttribute("role", "img");
      if (alt) svgEl.setAttribute("aria-label", alt);
      if (svgEl.hasAttribute("viewBox")) {
        svgEl.removeAttribute("width");
        svgEl.removeAttribute("height");
      }
      if (soleInP) {
        const figure = doc.createElement("figure");
        figure.className = "lesson-figure";
        figure.append(svgEl);
        replaceTarget.replaceWith(figure);
      } else {
        const wrapper = doc.createElement("span");
        wrapper.className = "lesson-inline-figure";
        wrapper.append(svgEl);
        replaceTarget.replaceWith(wrapper);
      }
      continue;
    }

    const png = doc.createElement("img");
    png.src = asset.data_url;
    png.alt = alt;
    png.className = "lesson-image-png";
    if (soleInP) {
      const figure = doc.createElement("figure");
      figure.className = "lesson-figure";
      figure.append(png);
      replaceTarget.replaceWith(figure);
    } else {
      replaceTarget.replaceWith(png);
    }
  }

  target.replaceChildren(template.content);
}
