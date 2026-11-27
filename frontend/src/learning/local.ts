// What practising works out on the device, from the deck and what's been done since it came:
// schedules, today's and this week's progress, and what to do next. The server works the same
// out from its log once the attempts reach it, and its answer replaces these.

import type { TrackId } from "../tracks/types";
import { DAY_MS, due, review } from "./schedule";
import type {
  Attempt,
  Deck,
  DeckItem,
  DeckLesson,
  FlagChange,
  Instance,
  ItemSchedule,
  LessonCompletion,
  Retirement,
  RetirementChange,
} from "./types";

/** The longest an attempt counts for towards time spent, as on the server. */
export const MAX_ATTEMPT_MS = 5 * 60 * 1000;

/** Roughly how many minutes of items are chosen at a time before picking the next step. */
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

/** Where each retired item stands, with the changes not yet synced applied. */
export function retirements(deck: Deck, changes: RetirementChange[]): Record<string, Retirement> {
  const result = { ...deck.retirements };
  const ordered = [...changes].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id));
  for (const change of ordered) {
    result[change.item] = { state: change.retired ? "retired" : "brought_back", at: change.at };
  }
  return result;
}

/** A track's retired items, in the deck's order. */
export function retired(deck: Deck, track: TrackId, changes: RetirementChange[]): DeckItem[] {
  const standing = retirements(deck, changes);
  return deck.items.filter(
    (item) => item.track === track && standing[item.key]?.state === "retired",
  );
}

/** Completion timestamps per lesson key, merging the deck's with completions waiting to sync. */
export function completedLessons(
  deck: Deck,
  pending: LessonCompletion[],
): Record<string, number[]> {
  const result: Record<string, number[]> = {};
  for (const [key, times] of Object.entries(deck.lesson_completions ?? {})) {
    result[key] = [...times];
  }
  for (const completion of pending) {
    const list = result[completion.lesson] ?? [];
    list.push(completion.completed_at);
    result[completion.lesson] = list;
  }
  for (const list of Object.values(result)) {
    list.sort((a, b) => a - b);
  }
  return result;
}

/** A track's lessons, in the deck's order. */
export function lessonsInTrack(deck: Deck, track: TrackId): DeckLesson[] {
  return (deck.lessons ?? []).filter((lesson) => lesson.track === track);
}

/** Prerequisites of `lesson` that have not been completed yet, with their titles. */
export function unmetRequires(
  deck: Deck,
  lesson: DeckLesson,
  completed: Record<string, number[]>,
): { key: string; title: string }[] {
  const byKey = new Map((deck.lessons ?? []).map((l) => [l.key, l]));
  return lesson.requires
    .filter((req) => (completed[req]?.length ?? 0) === 0)
    .map((req) => ({ key: req, title: byKey.get(req)?.title ?? req }));
}

/**
 * When an item that's been attempted is due: as its schedule says, unless it was brought back
 * since it was last attempted, which makes it due from then. As in crates/learning/src/plan.rs.
 */
function dueAt(schedule: ItemSchedule, retirement: Retirement | undefined, retention: number) {
  if (retirement?.state === "brought_back" && retirement.at > schedule.last_review) {
    return retirement.at;
  }
  return due(schedule, retention);
}

export interface Progress {
  /** Reviews today of items seen before today, which count towards the daily limit. */
  reviewsToday: number;
  /** Items first attempted today, which count towards the daily limit of new ones. */
  newToday: number;
  minutesThisWeek: number;
}

/**
 * The track whose daily limits a track's items count against: its own, if it's kept apart, or
 * null for the limits every other track shares, as on the server.
 */
export function limitsOf(deck: Deck, track: TrackId): TrackId | null {
  return deck.tracks.find((t) => t.id === track)?.kept_apart === true ? track : null;
}

/** The limits an item counts against, by its key, as `limitsOf` says. */
function limitsOfItem(deck: Deck, key: string): TrackId | null {
  const item = deck.items.find((i) => i.key === key);
  return item ? limitsOf(deck, item.track) : null;
}

/**
 * Today's and this week's progress: the deck's, if it was made today and this week, and what's
 * been done since. It's what counts towards the limits every track shares and the week's
 * target, or with `track`, towards that track's own limits, if it's kept apart.
 */
export function progress(
  deck: Deck,
  attempts: Attempt[],
  now: number,
  offset: number,
  track: TrackId | null = null,
): Progress {
  const limits = track === null ? null : limitsOf(deck, track);
  const known =
    limits === null
      ? deck.progress
      : (deck.tracks.find((t) => t.id === limits)?.progress ?? {
          reviews_today: 0,
          new_today: 0,
          minutes_this_week: 0,
        });
  const today = dayStart(now, offset);
  const week = weekStart(now, offset);
  const sameDay = deck.day_start === today;
  let reviewsToday = sameDay ? known.reviews_today : 0;
  let msThisWeek = deck.week_start === week ? known.minutes_this_week * 60_000 : 0;
  // Items first attempted today since the deck came; those first attempted before it came are
  // in the deck's count, as they have a schedule in it.
  const started = new Set<string>();
  for (const attempt of attempts.filter((a) => limitsOfItem(deck, a.item) === limits)) {
    if (attempt.answered_at >= week) msThisWeek += Math.min(attempt.duration_ms, MAX_ATTEMPT_MS);
    if (attempt.answered_at < today) continue;
    const scheduled = deck.schedules[attempt.item];
    const seenBefore =
      (scheduled?.last_review ?? Number.POSITIVE_INFINITY) < today ||
      attempts.some((other) => other.item === attempt.item && other.answered_at < today);
    if (seenBefore) reviewsToday++;
    else if (!scheduled) started.add(attempt.item);
  }
  const newToday = (sameDay ? (known.new_today ?? 0) : 0) + started.size;
  return { reviewsToday, newToday, minutesThisWeek: Math.floor(msThisWeek / 60_000) };
}

export interface Queue {
  /**
   * Cards whose follow-up questions are under way, to carry on with first, whatever today's
   * limits, as they're started already.
   */
  followUps: DeckItem[];
  /** Due now, within today's limit, most overdue first. */
  due: DeckItem[];
  /** Due, but waiting for tomorrow as today's limit is reached. */
  waiting: number;
  /**
   * Never attempted, within today's limit of new items: those in the skills recent mistakes
   * point to first, then in the deck's order.
   */
  fresh: DeckItem[];
  /** Never attempted, but waiting for tomorrow as today's limit of new items is reached. */
  freshWaiting: number;
}

/**
 * What there is to do in a track now: cards being followed up, then due reviews, then new items.
 */
export function queue(
  deck: Deck,
  track: TrackId,
  attempts: Attempt[],
  changes: FlagChange[],
  retirementChanges: RetirementChange[],
  now: number,
  offset: number,
): Queue {
  const scheduled = schedules(deck, attempts);
  const wrong = flagged(deck, changes);
  const standing = retirements(deck, retirementChanges);
  // Cards being followed up, unless answered since, which ends their follow-ups once it's
  // synced, come first, so the learner carries on where they left off.
  const answered = new Set(attempts.map((attempt) => attempt.item));
  const underWay = new Set((deck.follow_ups ?? []).filter((key) => !answered.has(key)));
  // Left out, as flagged items are: retired ones are never offered.
  const offered = (item: DeckItem) =>
    !wrong.has(item.key) && standing[item.key]?.state !== "retired";
  const followUps = deck.items.filter(
    (item) => item.track === track && underWay.has(item.key) && offered(item),
  );
  const rest = (item: DeckItem) => offered(item) && !underWay.has(item.key);
  const { reviewsToday, newToday } = progress(deck, attempts, now, offset, track);
  const allowed = Math.max(0, deck.limits.daily_reviews - reviewsToday);
  // The daily limit is shared across tracks, as on the server, so it's spent on the most overdue
  // items anywhere, but in tracks kept apart, which each have a limit of their own.
  const limits = limitsOf(deck, track);
  const dueEverywhere = deck.items
    .filter((item) => rest(item) && limitsOf(deck, item.track) === limits)
    .flatMap((item) => {
      const schedule = scheduled[item.key];
      if (!schedule) return [];
      const when = dueAt(schedule, standing[item.key], deck.limits.retention);
      return when <= now ? [{ item, when }] : [];
    })
    .sort((a, b) => a.when - b.when || a.item.key.localeCompare(b.item.key));
  const within = dueEverywhere.slice(0, allowed);
  // Also shared across tracks but those kept apart, so each offers up to what's left of it, as
  // on the server.
  const allowedNew = Math.max(0, (deck.limits.daily_new ?? Number.POSITIVE_INFINITY) - newToday);
  const fresh = deck.items
    .filter((item) => item.track === track && rest(item) && !scheduled[item.key])
    // Sorting is stable, so otherwise they keep the deck's order.
    .sort((a, b) => Number(inFocus(deck, b)) - Number(inFocus(deck, a)));
  return {
    followUps,
    due: within.filter(({ item }) => item.track === track).map(({ item }) => item),
    waiting: dueEverywhere.slice(allowed).filter(({ item }) => item.track === track).length,
    fresh: fresh.slice(0, allowedNew),
    freshWaiting: Math.max(0, fresh.length - allowedNew),
  };
}

/** Whether an item practises a skill that recent mistakes point to. */
function inFocus(deck: Deck, item: DeckItem): boolean {
  return item.skills.some((skill) => deck.focus?.includes(skill) ?? false);
}

/**
 * The items for one step: cards being followed up first, then due ones, then new, until there's
 * a few minutes' worth. Items in `exclude` are left out, so the next step doesn't straight away
 * re-offer one from the step just finished.
 */
export function step(next: Queue, exclude: ReadonlySet<string> = new Set()): DeckItem[] {
  const chosen: DeckItem[] = [];
  let minutes = 0;
  for (const item of [...next.followUps, ...next.due, ...next.fresh]) {
    if (exclude.has(item.key)) continue;
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
