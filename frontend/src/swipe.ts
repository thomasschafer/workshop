// Two fingers swept sideways together, which turns to the next tab or the one before. Two, as one
// finger scrolls code and moves the cursor, and a sweep from the screen's edge goes back.

import type { Point } from "./touchModel";

export type Fingers = readonly [Point, Point];

/** How far, in pixels, both fingers must travel sideways. */
export const SWIPE_DISTANCE = 70;
/** Fingers that end this much further apart or closer together than they began were pinching. */
export const SWIPE_SPREAD = 0.25;

const apart = ([a, b]: Fingers) => Math.hypot(a.x - b.x, a.y - b.y);

/**
 * Which way two fingers swept, from where they came down to where they lifted, or null if they
 * didn't: both must travel far enough the same way, more sideways than up or down, staying about
 * as far apart as they began.
 */
export function swipeDirection(start: Fingers, end: Fingers): "left" | "right" | null {
  const moves = [0, 1].map((i) => {
    const [from, to] = [start[i as 0 | 1], end[i as 0 | 1]];
    return { dx: to.x - from.x, dy: to.y - from.y };
  });
  const [first, second] = moves;
  if (!first || !second) return null;
  if (Math.sign(first.dx) !== Math.sign(second.dx)) return null;
  for (const { dx, dy } of moves) {
    if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dy) > Math.abs(dx) * 0.6) return null;
  }
  const before = apart(start);
  if (before > 0 && Math.abs(apart(end) / before - 1) > SWIPE_SPREAD) return null;
  return first.dx < 0 ? "left" : "right";
}

/**
 * Calls `onSwipe` for two-finger sweeps that begin within `target` and not on anything matching
 * `ignore`, such as a keyboard, where two fingers are two keys. Returns a function that stops
 * listening.
 */
export function watchSwipes(
  target: HTMLElement,
  ignore: string,
  onSwipe: (direction: "left" | "right") => void,
): () => void {
  /** Where each of the two fingers came down and is now, by its identifier. */
  let fingers: Map<number, { start: Point; now: Point }> | null = null;

  const point = (t: Touch): Point => ({ x: t.clientX, y: t.clientY });
  const onStart = (e: TouchEvent) => {
    const touches = Array.from(e.touches);
    const ignored = touches.some((t) => t.target instanceof Element && t.target.closest(ignore));
    // A third finger, or one somewhere two fingers mean something else, ends any sweep.
    fingers =
      touches.length === 2 && !ignored
        ? new Map(touches.map((t) => [t.identifier, { start: point(t), now: point(t) }]))
        : null;
  };
  const onMove = (e: TouchEvent) => {
    if (fingers === null) return;
    for (const t of Array.from(e.touches)) {
      const finger = fingers.get(t.identifier);
      if (finger) finger.now = point(t);
    }
  };
  const onEnd = () => {
    const tracked = fingers;
    fingers = null;
    if (tracked === null) return;
    const [a, b] = [...tracked.values()];
    if (!a || !b) return;
    const direction = swipeDirection([a.start, b.start], [a.now, b.now]);
    if (direction) onSwipe(direction);
  };
  const onCancel = () => {
    fingers = null;
  };
  target.addEventListener("touchstart", onStart, { passive: true });
  target.addEventListener("touchmove", onMove, { passive: true });
  target.addEventListener("touchend", onEnd, { passive: true });
  target.addEventListener("touchcancel", onCancel, { passive: true });
  return () => {
    target.removeEventListener("touchstart", onStart);
    target.removeEventListener("touchmove", onMove);
    target.removeEventListener("touchend", onEnd);
    target.removeEventListener("touchcancel", onCancel);
  };
}
