import type { RefObject } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";

/** Settles quickly, with a hint of overshoot, so movement feels physical. */
export const SPRING = "cubic-bezier(0.2, 0.9, 0.25, 1.1)";

/**
 * Animates a container's children between layouts: ones that appear grow in, and ones that move
 * glide there, rather than jumping. Children take part when they have a `data-flip` key that
 * stays the same across renders.
 *
 * Only transforms are animated. Animating size would change the layout as it ran, which this
 * measures, and anything watching the container's size would re-render it mid-animation.
 */
export function useFlip(container: RefObject<HTMLElement | null>): void {
  const previous = useRef(new Map<string, number>());
  useLayoutEffect(() => {
    const parent = container.current;
    if (!parent) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const next = new Map<string, number>();
    for (const child of Array.from(parent.children)) {
      if (!(child instanceof HTMLElement) || !child.dataset.flip) continue;
      // The layout position, unaffected by any animation under way.
      const top = child.offsetTop;
      next.set(child.dataset.flip, top);
      const before = previous.current.get(child.dataset.flip);
      if (!before) {
        child.animate(
          reduceMotion
            ? [{ opacity: 0 }, { opacity: 1 }]
            : [
                { opacity: 0, transform: "translateY(14px) scale(0.97)" },
                { opacity: 1, transform: "none" },
              ],
          { duration: reduceMotion ? 150 : 260, easing: SPRING },
        );
        continue;
      }
      const moved = before - top;
      if (reduceMotion || Math.abs(moved) < 1) continue;
      child.animate([{ transform: `translateY(${moved}px)` }, { transform: "none" }], {
        duration: 240,
        easing: SPRING,
      });
    }
    previous.current = next;
  });
}
