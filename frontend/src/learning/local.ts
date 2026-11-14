// What practising works out on the device, from the deck and what's been done since it came:
// schedules, today's and this week's progress, and what to do next. The server works the same
// out from its log once the attempts reach it, and its answer replaces these.

import type { TrackId } from "../tracks/types";
import { DAY_MS, due, review } from "./schedule";
import type { Attempt, Deck, DeckItem, FlagChange, Instance, ItemSchedule } from "./types";

/** The longest an attempt counts for towards time spent, as on the server. */
export const MAX_ATTEMPT_MS = 5 * 60 * 1000;

/** Roughly how many minutes a step takes: a few items, so it fits in a short gap. */
export const STEP_MINUTES = 3;

/** How far the device's time is ahead of UTC, in minutes, as the server's API takes it. */
export function utcOffset(at: Date = new Date()): number {
  // getTimezoneOffset is how far UTC is ahead of local time.
  return -at.getTimezoneOffset();
}

/** The start of the learner's day, in milliseconds since 1970. */
export function dayStart(now: number, offsetMinutes: number): number {
  const offset = offsetMinutes * 60_000;
  return Math.floor((now + offset) / DAY_MS) * DAY_MS - offset;
}

/** The start of the learner's week, on Monday. */
export function weekStart(now: number, offsetMinutes: number): number {
  const offset = offsetMinutes * 60_000;
  const day = Math.floor((now + offset) / DAY_MS);
  // 1 January 1970 was a Thursday, three days after a Monday.
  const sinceMonday = (((day + 3) % 7) + 7) % 7;
  return dayStart(now, offsetMinutes) - sinceMonday * DAY_MS;
}

/** Each item's schedule, with the attempts not yet synced applied on top of the deck's. */
export function schedules(deck: Deck, attempts: Attempt[]): Record<string, ItemSchedule> {
  const result = { ...deck.schedules };
  const ordered = [...attempts].sort(
    (a, b) => a.answered_at - b.answered_at || a.id.localeCompare(b.id),
  );
  for (const attempt of ordered) {
    result[attempt.item] = review(
      result[attempt.item] ?? null,
      attempt.answered_at,
      attempt.rating,
    );
  }
  return result;
}

/** The items flagged as wrong, with the changes not yet synced applied. */
export function flagged(deck: Deck, changes: FlagChange[]): Set<string> {
  const result = new Set(Object.keys(deck.flags));
  const ordered = [...changes].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const change of ordered) {
    if (change.flagged) result.add(change.item);
    else result.delete(change.item);
  }
  return result;
}

export interface Progress {
  /** Reviews today of items seen before today, which count towards the daily limit. */
  reviewsToday: number;
  minutesThisWeek: number;
}

/**
 * Today's and this week's progress: the deck's, if it was made today and this week, and what's
 * been done since.
 */
export function progress(deck: Deck, attempts: Attempt[], now: number, offset: number): Progress {
  const today = dayStart(now, offset);
  const week = weekStart(now, offset);
  let reviewsToday = deck.day_start === today ? deck.progress.reviews_today : 0;
  let msThisWeek = deck.week_start === week ? deck.progress.minutes_this_week * 60_000 : 0;
  for (const attempt of attempts) {
    if (attempt.answered_at >= week) msThisWeek += Math.min(attempt.duration_ms, MAX_ATTEMPT_MS);
    if (attempt.answered_at < today) continue;
    const seenBefore =
      (deck.schedules[attempt.item]?.last_review ?? Number.POSITIVE_INFINITY) < today ||
      attempts.some((other) => other.item === attempt.item && other.answered_at < today);
    if (seenBefore) reviewsToday++;
  }
  return { reviewsToday, minutesThisWeek: Math.floor(msThisWeek / 60_000) };
}

export interface Queue {
  /** Due now, within today's limit, most overdue first. */
  due: DeckItem[];
  /** Due, but waiting for tomorrow as today's limit is reached. */
  waiting: number;
  /** Never attempted, in the deck's order. */
  fresh: DeckItem[];
}

/** What there is to do in a track now: due reviews first, then new items. */
export function queue(
  deck: Deck,
  track: TrackId,
  attempts: Attempt[],
  changes: FlagChange[],
  now: number,
  offset: number,
): Queue {
  const scheduled = schedules(deck, attempts);
  const wrong = flagged(deck, changes);
  const { reviewsToday } = progress(deck, attempts, now, offset);
  const allowed = Math.max(0, deck.limits.daily_reviews - reviewsToday);
  // The daily limit is shared across tracks, as on the server, so it's spent on the most overdue
  // items anywhere.
  const dueEverywhere = deck.items
    .filter((item) => !wrong.has(item.key))
    .flatMap((item) => {
      const schedule = scheduled[item.key];
      if (!schedule) return [];
      const when = due(schedule, deck.limits.retention);
      return when <= now ? [{ item, when }] : [];
    })
    .sort((a, b) => a.when - b.when || a.item.key.localeCompare(b.item.key));
  const within = dueEverywhere.slice(0, allowed);
  return {
    due: within.filter(({ item }) => item.track === track).map(({ item }) => item),
    waiting: dueEverywhere.slice(allowed).filter(({ item }) => item.track === track).length,
    fresh: deck.items.filter(
      (item) => item.track === track && !wrong.has(item.key) && !scheduled[item.key],
    ),
  };
}

/** The items for one step: due ones first, then new, until there's a few minutes' worth. */
export function step(next: Queue): DeckItem[] {
  const chosen: DeckItem[] = [];
  let minutes = 0;
  for (const item of [...next.due, ...next.fresh]) {
    if (minutes >= STEP_MINUTES) break;
    chosen.push(item);
    minutes += item.minutes;
  }
  return chosen;
}

/** The question to ask next from a mental maths template: one not yet used since the deck came. */
export function nextInstance(instances: Instance[], attempts: Attempt[], key: string): Instance {
  const used = attempts.filter((attempt) => attempt.item === key).length;
  const instance = instances[used % instances.length];
  if (!instance) throw new Error(`${key} has no questions in the deck`);
  return instance;
}

/** A random id, as a UUID, which also works where `crypto.randomUUID` isn't allowed. */
export function newId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
