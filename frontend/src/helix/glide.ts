/** How long a glide takes, in milliseconds. */
const DURATION = 160;

/** Fast at first and settling gently, as a flicked page does. */
function easeOut(t: number): number {
  return 1 - (1 - t) ** 3;
}

function reducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

interface Glide {
  from: number;
  to: number;
  start: number;
  frame: number;
}

/**
 * Glides an element's vertical scroll to where a change puts it, rather than jumping there.
 *
 * What reads the scroll mid-glide, such as the next of several scrolling keys pressed quickly,
 * settles it first, so it sees where the glide ends rather than somewhere on the way. The next
 * glide then carries on from where the element was shown, so nothing jumps.
 */
export class ScrollGlide {
  private glide: Glide | null = null;
  /** Where the element was shown when a glide was settled early, and where that put it. */
  private settled: { shown: number; to: number } | null = null;

  constructor(private readonly el: HTMLElement) {
    // Scrolling by hand takes over from a glide, where it's got to.
    el.addEventListener("wheel", this.stop, { passive: true });
    el.addEventListener("touchstart", this.stop, { passive: true });
  }

  /** Puts the element where it's gliding to, so its scroll can be read as it will be. */
  settle(): void {
    const g = this.glide;
    if (!g) return;
    cancelAnimationFrame(g.frame);
    this.glide = null;
    const shown = this.el.scrollTop;
    this.el.scrollTop = g.to;
    this.settled = { shown, to: this.el.scrollTop };
  }

  /**
   * Makes `change`, which may scroll the element, and glides there if `smooth`, or if a glide was
   * already under way, so it carries on rather than jumping. `change` returns false if the
   * scroll it leaves isn't where the element ends up, as when CodeMirror scrolls later itself,
   * so there's nothing to glide to.
   */
  run(change: () => boolean, smooth: boolean): void {
    this.settle();
    const settled = this.settled;
    this.settled = null;
    // Only if nothing has scrolled it since it was settled.
    const carried = settled !== null && Math.abs(this.el.scrollTop - settled.to) < 1;
    const from = carried ? settled.shown : this.el.scrollTop;
    if (!change()) return;
    const to = this.el.scrollTop;
    if (!(smooth || carried) || Math.abs(to - from) < 1 || reducedMotion()) return;
    this.el.scrollTop = from;
    const glide: Glide = { from, to, start: performance.now(), frame: 0 };
    const step = (now: number) => {
      const t = Math.min(1, (now - glide.start) / DURATION);
      this.el.scrollTop = t < 1 ? glide.from + (glide.to - glide.from) * easeOut(t) : glide.to;
      if (t < 1) glide.frame = requestAnimationFrame(step);
      else this.glide = null;
    };
    glide.frame = requestAnimationFrame(step);
    this.glide = glide;
  }

  private readonly stop = () => {
    if (this.glide) cancelAnimationFrame(this.glide.frame);
    this.glide = null;
    this.settled = null;
  };

  destroy(): void {
    this.stop();
    this.el.removeEventListener("wheel", this.stop);
    this.el.removeEventListener("touchstart", this.stop);
  }
}
