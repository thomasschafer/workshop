import type { EditorView } from "@codemirror/view";
import { pinchedCodeScale, roundCodeScale } from "./zoom";

export interface PinchOptions {
  /** The text's scale as the pinch begins. */
  scale(): number;
  /** Shows the text at `scale`, as the fingers move. */
  apply(scale: number): void;
  /** Called with the scale the text was left at, once the fingers are lifted. */
  done(scale: number): void;
}

interface Point {
  x: number;
  y: number;
}

interface Pinch {
  startScale: number;
  startDistance: number;
  /** The start of the line between the fingers when the pinch began, which is kept between them. */
  line: number;
  /** How far down that line the point between the fingers was, as a fraction of its height. */
  lineFraction: number;
  /** How far the code was scrolled sideways, in pixels at the starting scale. */
  scrollLeft: number;
  scale: number;
  distance: number;
  centre: Point;
  frame: number | null;
}

function distance(a: Touch, b: Touch): number {
  return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
}

function centre(a: Touch, b: Touch): Point {
  return { x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 };
}

/**
 * Pinching the editor with two fingers scales its text, rather than zooming the whole page,
 * keeping the line between the fingers where it is. Returns a function that stops listening.
 */
export function pinchToZoom(view: EditorView, options: PinchOptions): () => void {
  let pinch: Pinch | null = null;
  const measureKey = {};

  const begin = (a: Touch, b: Touch) => {
    const at = centre(a, b);
    const block = view.lineBlockAtHeight(at.y - view.documentTop);
    const startScale = options.scale();
    pinch = {
      startScale,
      startDistance: distance(a, b),
      line: block.from,
      lineFraction: block.height > 0 ? (at.y - view.documentTop - block.top) / block.height : 0,
      scrollLeft: view.scrollDOM.scrollLeft,
      scale: startScale,
      distance: distance(a, b),
      centre: at,
      frame: null,
    };
  };

  /**
   * Scales the text to where the fingers are now, and scrolls to keep the line between them
   * there. Sideways, the scroll only grows with the text, so lines that started in view still do.
   */
  const update = () => {
    const p = pinch;
    if (!p) return;
    p.frame = null;
    p.scale = roundCodeScale(pinchedCodeScale(p.startScale, p.startDistance, p.distance));
    options.apply(p.scale);
    const { centre: at, line, lineFraction, scrollLeft } = p;
    const ratio = p.scale / p.startScale;
    view.requestMeasure({
      key: measureKey,
      read: (v) => ({ block: v.lineBlockAt(line), documentTop: v.documentTop }),
      write: ({ block, documentTop }, v) => {
        v.scrollDOM.scrollTop += documentTop + block.top + lineFraction * block.height - at.y;
        v.scrollDOM.scrollLeft = scrollLeft * ratio;
      },
    });
  };

  const end = () => {
    const p = pinch;
    if (!p) return;
    if (p.frame !== null) {
      cancelAnimationFrame(p.frame);
      update();
    }
    pinch = null;
    options.done(p.scale);
  };

  /**
   * The fingers on the editor. Not `targetTouches`, which only has those on the element the
   * touch began on, such as one word of the code.
   */
  const fingers = (e: TouchEvent): Touch[] =>
    Array.from(e.touches).filter((t) => t.target instanceof Node && view.dom.contains(t.target));

  const onTouchStart = (e: TouchEvent) => {
    const [a, b, ...more] = fingers(e);
    if (a && b && more.length === 0) begin(a, b);
    else end();
  };

  const onTouchMove = (e: TouchEvent) => {
    const p = pinch;
    const [a, b, ...more] = fingers(e);
    if (!p || !a || !b || more.length > 0) return;
    // The pinch scrolls the code itself, so the browser mustn't scroll it as well.
    if (e.cancelable) e.preventDefault();
    p.distance = distance(a, b);
    p.centre = centre(a, b);
    p.frame ??= requestAnimationFrame(update);
  };

  const onTouchEnd = (e: TouchEvent) => {
    if (fingers(e).length < 2) end();
  };

  // Safari zooms the page on its own gesture events, whatever the editor's touch-action says.
  const onGesture = (e: Event) => e.preventDefault();

  const dom = view.dom;
  dom.addEventListener("touchstart", onTouchStart, { passive: true });
  dom.addEventListener("touchmove", onTouchMove, { passive: false });
  dom.addEventListener("touchend", onTouchEnd, { passive: true });
  dom.addEventListener("touchcancel", onTouchEnd, { passive: true });
  dom.addEventListener("gesturestart", onGesture, { passive: false });
  dom.addEventListener("gesturechange", onGesture, { passive: false });
  return () => {
    if (pinch?.frame != null) cancelAnimationFrame(pinch.frame);
    pinch = null;
    dom.removeEventListener("touchstart", onTouchStart);
    dom.removeEventListener("touchmove", onTouchMove);
    dom.removeEventListener("touchend", onTouchEnd);
    dom.removeEventListener("touchcancel", onTouchEnd);
    dom.removeEventListener("gesturestart", onGesture);
    dom.removeEventListener("gesturechange", onGesture);
  };
}
