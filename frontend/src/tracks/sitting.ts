/**
 * "I've got a while": the learner saying they have time for long items, such as timed rounds and
 * design sessions, which Continue then offers. It's for the current sitting only, so it's kept
 * on this device rather than the server, and it turns itself off once the learner has been
 * away from the app for a while: a short gap later, on any device, doesn't get a long item.
 *
 * The sitting is taken to have ended after `IDLE_MS` with nothing done in the app, rather than
 * a fixed time after switching it on, so a long item never runs out from under the learner
 * while they're working on it, however long it takes.
 */

/** How long without doing anything in the app ends the sitting. */
export const IDLE_MS = 30 * 60_000;

/** Activity is noted at most this often, as every tap would be far more than needed. */
export const TOUCH_MS = 60_000;

const KEY = "workshop:a-while";

/** On, and when the learner last did something in the app. */
export interface Sitting {
  lastActive: number;
}

/** Whether a sitting kept as `stored` is still going at `now`. */
export function isOn(stored: Sitting | null, now: number): boolean {
  return stored !== null && now - stored.lastActive < IDLE_MS && now >= stored.lastActive;
}

/** Reads a kept sitting, or null for none or one that isn't in the shape kept. */
export function parse(stored: string | null): Sitting | null {
  if (stored === null) return null;
  try {
    const value = JSON.parse(stored) as unknown;
    if (
      typeof value === "object" &&
      value !== null &&
      "lastActive" in value &&
      typeof value.lastActive === "number" &&
      Number.isFinite(value.lastActive)
    ) {
      return { lastActive: value.lastActive };
    }
  } catch {
    // Not JSON: as if it were off.
  }
  return null;
}

function read(): Sitting | null {
  try {
    return parse(localStorage.getItem(KEY));
  } catch {
    return null;
  }
}

function write(sitting: Sitting | null): void {
  try {
    if (sitting === null) localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, JSON.stringify(sitting));
  } catch {
    // Storage can be full or disabled; it's then off again after a reload, which is safe.
  }
}

/** Whether the learner has a while now. */
export function aWhile(now = Date.now()): boolean {
  return isOn(read(), now);
}

/** Turns it on, for this sitting, or off. */
export function setAWhile(on: boolean, now = Date.now()): void {
  write(on ? { lastActive: now } : null);
}

/**
 * Notes that the learner is doing something in the app, which keeps the sitting going. Once
 * it's ended, it stays off: only the learner turns it on again.
 */
export function touch(now = Date.now()): void {
  const stored = read();
  if (stored === null) return;
  if (!isOn(stored, now)) {
    write(null);
    return;
  }
  if (now - stored.lastActive >= TOUCH_MS) write({ lastActive: now });
}

/** Keeps the sitting going while the learner does things in the app. Returns how to stop. */
export function watchActivity(): () => void {
  const noted = () => touch();
  const events = ["pointerdown", "keydown", "input"] as const;
  for (const event of events) window.addEventListener(event, noted, { passive: true });
  return () => {
    for (const event of events) window.removeEventListener(event, noted);
  };
}
