import { afterEach, describe, expect, it, vi } from "vitest";
import { GLIDE_MS, ScrollGlide } from "./glide";

/** An element that only scrolls, and the frames it would be drawn in, which the test draws. */
function stubPage() {
  const frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  let now = 1000;
  vi.stubGlobal("performance", { now: () => now });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
    frames.set(++next, callback);
    return next;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }) });
  const el = { scrollTop: 0, addEventListener: () => {}, removeEventListener: () => {} };
  /** Draws a frame that began at `at`, running what was waiting for it. */
  const draw = (at: number) => {
    const waiting = [...frames.values()];
    frames.clear();
    for (const callback of waiting) callback(at);
  };
  const advance = (ms: number) => {
    now += ms;
  };
  return { el, draw, advance, now: () => now };
}

describe("gliding the scroll", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never goes back past where it started, in a frame begun before the glide was", () => {
    const page = stubPage();
    const glide = new ScrollGlide(page.el as unknown as HTMLElement);
    page.el.scrollTop = 500;
    glide.run(() => {
      page.el.scrollTop = 900;
      return true;
    }, true);
    expect(page.el.scrollTop).toBe(500);
    // The frame the key arrived in began a few milliseconds before it was handled.
    page.draw(page.now() - 7);
    expect(page.el.scrollTop).toBe(500);
    page.advance(GLIDE_MS / 2);
    page.draw(page.now());
    expect(page.el.scrollTop).toBeGreaterThan(500);
    expect(page.el.scrollTop).toBeLessThan(900);
    page.advance(GLIDE_MS);
    page.draw(page.now());
    expect(page.el.scrollTop).toBe(900);
  });
});
