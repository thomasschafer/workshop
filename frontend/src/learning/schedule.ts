// The app's own scheduling, for attempts made before they reach the server, whose schedule is
// the one that counts once they do. It must agree with crates/learning/src/schedule.rs, which
// schedule.test.ts checks against the cases in crates/learning/tests/fsrs.json.

import { FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS, FSRS7Algorithm } from "ts-fsrs/models/fsrs-7";
import type { ItemSchedule, Rating } from "./types";

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The soonest an item comes back, however badly it went. */
export const MIN_INTERVAL_MS = 10 * 60 * 1000;
/** The longest an item goes without coming back. */
export const MAX_INTERVAL_MS = 365 * DAY_MS;

const fsrs = new FSRS7Algorithm(FSRS7_DEFAULT_WEIGHTS, FSRS7_MODEL_BOUNDS);

const GRADES: Record<Rating, number> = { again: 1, hard: 2, good: 3, easy: 4 };

/** The item's memory after one more attempt, at `at` milliseconds since 1970. */
export function review(before: ItemSchedule | null, at: number, rating: Rating): ItemSchedule {
  const elapsedDays = before ? Math.max(0, at - before.last_review) / DAY_MS : 0;
  const memory = before
    ? {
        stability: before.stability,
        difficulty: before.difficulty,
        stabilityFast: before.stability_fast,
      }
    : null;
  const next = fsrs.next_state(memory, elapsedDays, GRADES[rating]);
  return {
    stability: next.stability,
    difficulty: next.difficulty,
    stability_fast: next.stabilityFast,
    last_review: at,
    reviews: (before?.reviews ?? 0) + 1,
    lapses: (before?.lapses ?? 0) + (before !== null && rating === "again" ? 1 : 0),
  };
}

/** When the item should next be attempted, for recall to have fallen to `retention`. */
export function due(schedule: ItemSchedule, retention: number): number {
  const days = fsrs.next_interval(
    {
      stability: schedule.stability,
      difficulty: schedule.difficulty,
      stabilityFast: schedule.stability_fast,
    },
    retention,
  );
  const interval = Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, days * DAY_MS));
  return schedule.last_review + Math.trunc(interval);
}
