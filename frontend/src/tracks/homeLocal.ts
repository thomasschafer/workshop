// Local patching of a cached `/api/home` snapshot so Home renders immediately offline or on a
// slow connection and reflects offline short-item reviews straight away without porting all of
// `crates/tracks`.

import {
  completedLessons,
  dayStart,
  flagged,
  progress,
  queue,
  retirements,
  skippedLessons,
} from "../learning/local";
import type {
  Attempt,
  Deck,
  FlagChange,
  LessonCompletion,
  LessonSkip,
  RetirementChange,
} from "../learning/types";
import type { Home, Track } from "./types";

/** Cache key in IndexedDB for a `/api/home` snapshot. */
export function homeSnapshotKey(aWhile: boolean, utcOffsetMinutes: number): string {
  return `home:${aWhile ? "a_while" : "short"}:${utcOffsetMinutes}`;
}

/**
 * Patches a cached Home snapshot with local offline learning state:
 * - updates weekly minutes from `local.ts`
 * - updates short-item track summaries for tracks whose items live in the deck
 * - drops a `continue` target that has already been completed/retired/flagged/skipped locally.
 */
export function patchHome(
  snapshot: Home,
  deck: Deck | null,
  attempts: Attempt[],
  flagChanges: FlagChange[],
  retirementChanges: RetirementChange[],
  now: number,
  offsetMinutes: number,
  lessonCompletions: LessonCompletion[] = [],
  lessonSkips: LessonSkip[] = [],
): Home {
  if (!deck) return snapshot;
  if (
    attempts.length === 0 &&
    flagChanges.length === 0 &&
    retirementChanges.length === 0 &&
    lessonCompletions.length === 0 &&
    lessonSkips.length === 0
  ) {
    return snapshot;
  }

  const weekProgress = progress(deck, attempts, now, offsetMinutes, null, lessonCompletions);
  const week = snapshot.week
    ? {
        ...snapshot.week,
        minutes: Math.max(snapshot.week.minutes, weekProgress.minutesThisWeek),
      }
    : null;

  const wrong = flagged(deck, flagChanges);
  const standing = retirements(deck, retirementChanges);
  const answeredKeys = new Set(attempts.map((a) => a.item));
  const completed = completedLessons(deck, lessonCompletions);
  const skipped = skippedLessons(deck, lessonSkips);
  const today = dayStart(now, offsetMinutes);

  const tracks: Track[] = snapshot.tracks.map((track) => {
    // Only patch pure short-item practice tracks whose summary is fully derived from the deck.
    if (track.destination.kind !== "practice") {
      return track;
    }
    const itemsInTrack = deck.items.filter((item) => item.track === track.id);
    if (itemsInTrack.length === 0) return track;
    const q = queue(
      deck,
      track.id,
      attempts,
      flagChanges,
      retirementChanges,
      now,
      offsetMinutes,
      lessonCompletions,
      lessonSkips,
    );
    const flaggedCount = itemsInTrack.filter((item) => wrong.has(item.key)).length;
    const parts: string[] = [];
    if (q.followUps.length > 0) parts.push(`${q.followUps.length} being followed up`);
    if (q.due.length > 0) parts.push(`${q.due.length} due`);
    if (q.lesson !== null) parts.push("1 lesson");
    const newTotal = q.fresh.length + q.freshWaiting;
    if (newTotal > 0) parts.push(`${newTotal} new`);
    if (q.waiting > 0) parts.push(`${q.waiting} waiting`);
    if (flaggedCount > 0) parts.push(`${flaggedCount} flagged`);
    const summary = parts.length > 0 ? parts.join(" · ") : "All caught up for now";
    return { ...track, summary };
  });

  let next = snapshot.continue;
  if (next) {
    if (next.destination.kind === "practice") {
      const trackId = next.destination.track;
      const itemsInTrack = deck.items.filter((item) => item.track === trackId);
      if (itemsInTrack.length > 0) {
        const q = queue(
          deck,
          trackId,
          attempts,
          flagChanges,
          retirementChanges,
          now,
          offsetMinutes,
          lessonCompletions,
          lessonSkips,
        );
        if (
          q.followUps.length === 0 &&
          q.due.length === 0 &&
          q.lesson === null &&
          q.fresh.length === 0
        ) {
          next = null;
        }
      }
    } else if (next.destination.kind === "lesson") {
      const key = next.destination.item;
      const done = (completed[key]?.length ?? 0) > 0;
      const skippedToday = skipped[key]?.some((at) => at >= today) ?? false;
      const dailyLimit = deck.limits.daily_lessons ?? 1;
      const lessonTrack = (deck.lessons ?? []).find((l) => l.key === key)?.track ?? null;
      const trackProgress = progress(
        deck,
        attempts,
        now,
        offsetMinutes,
        lessonTrack,
        lessonCompletions,
      );
      if (done || skippedToday || trackProgress.lessonsToday >= dailyLimit) {
        next = null;
      }
    } else if (next.destination.kind === "coding" && next.destination.item !== null) {
      const key = next.destination.item;
      const isShort = deck.items.some((item) => item.key === key);
      if (
        isShort &&
        (answeredKeys.has(key) || wrong.has(key) || standing[key]?.state === "retired")
      ) {
        next = null;
      }
    }
  }

  return {
    ...snapshot,
    continue: next,
    tracks,
    week,
  };
}
