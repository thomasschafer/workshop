import type { Clock } from "./types";

/**
 * How often the app tells the server a round is still open. The server counts a gap between
 * two of these for no more than `MAX_GAP_MS`, as in crates/sessions/src/round.rs, so this must
 * be well inside it.
 */
export const BEAT_MS = 5_000;
export const MAX_GAP_MS = 20_000;

/**
 * The time left `sinceMs` after the server said how much was, as the server will count it:
 * no more than a short gap passes without another word from the app, such as while offline.
 */
export function remainingAfter(clock: Clock, sinceMs: number): number {
  return Math.max(0, clock.remaining_ms - Math.min(Math.max(0, sinceMs), MAX_GAP_MS));
}

/** Time left on the clock, in minutes and seconds, rounded up so it shows 0:00 only at the end. */
export function clockText(ms: number): string {
  const seconds = Math.ceil(Math.max(0, ms) / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}
