import { describe, expect, it } from "vitest";
import {
  dayStart,
  flagged,
  newId,
  nextInstance,
  progress,
  queue,
  retired,
  step,
  weekStart,
} from "./local";
import { DAY_MS, review } from "./schedule";
import type { Attempt, Deck, DeckItem, RetirementChange } from "./types";

// 2026-09-21, a Monday, at 23:30 UTC.
const LATE_MONDAY = 1_790_033_400_000;
const MONDAY = 1_789_948_800_000;

function card(key: string, track: DeckItem["track"] = "review"): DeckItem {
  return {
    key,
    track,
    kind: "card",
    label: key,
    skills: [],
    prompt: "Q",
    source: null,
    minutes: 1,
    answer: "A",
    explanation: null,
  };
}

function deck(items: DeckItem[], changes: Partial<Deck> = {}): Deck {
  return {
    limits: { daily_reviews: 40, daily_new: 10, weekly_minutes: 60, retention: 0.9 },
    progress: { reviews_today: 0, new_today: 0, minutes_this_week: 0 },
    day_start: dayStart(LATE_MONDAY, 0),
    week_start: weekStart(LATE_MONDAY, 0),
    tracks: [],
    items,
    schedules: {},
    flags: {},
    skills: [],
    focus: [],
    problems: [],
    ...changes,
  };
}

function attempt(item: string, at: number, rating: Attempt["rating"] = "good"): Attempt {
  return { id: newId(), item, answered_at: at, duration_ms: 30_000, rating };
}

describe("dayStart and weekStart", () => {
  it("find the learner's day and week as the server does", () => {
    expect(dayStart(LATE_MONDAY, 0)).toBe(MONDAY);
    expect(weekStart(LATE_MONDAY, 0)).toBe(MONDAY);
    // An hour ahead, it's already Tuesday.
    expect(dayStart(LATE_MONDAY, 60)).toBe(MONDAY + DAY_MS - 3_600_000);
    expect(weekStart(LATE_MONDAY, 60)).toBe(MONDAY - 3_600_000);
    expect(dayStart(LATE_MONDAY, -300)).toBe(MONDAY + 300 * 60_000);
  });
});

describe("queue", () => {
  it("offers due reviews first, within the daily limit, then new items", () => {
    const items = [
      card("p/a"),
      card("p/b"),
      card("p/c"),
      card("p/new"),
      card("p/sum", "mental-maths"),
    ];
    const seen = (days: number) => review(null, LATE_MONDAY - days * DAY_MS, "good");
    const d = deck(items, {
      schedules: { "p/a": seen(30), "p/b": seen(60), "p/c": seen(45), "p/sum": seen(90) },
      limits: { daily_reviews: 3, weekly_minutes: 60, retention: 0.9 },
      progress: { reviews_today: 1, minutes_this_week: 0 },
    });
    const next = queue(d, "review", [], [], [], LATE_MONDAY, 0);
    // Two reviews left today, and p/sum in another track is the most overdue.
    expect(next.due.map((item) => item.key)).toEqual(["p/b"]);
    expect(next.waiting).toBe(2);
    expect(next.fresh.map((item) => item.key)).toEqual(["p/new"]);
  });

  it("takes what's been done since the deck came into account", () => {
    const d = deck([card("p/a"), card("p/b")]);
    const done = [attempt("p/a", LATE_MONDAY - 60_000, "good")];
    const next = queue(d, "review", done, [], [], LATE_MONDAY, 0);
    expect(next.due).toEqual([]);
    expect(next.fresh.map((item) => item.key)).toEqual(["p/b"]);
    // Forgotten, it comes back ten minutes later.
    const forgotten = [attempt("p/a", LATE_MONDAY - 11 * 60_000, "again")];
    expect(queue(d, "review", forgotten, [], [], LATE_MONDAY, 0).due.map((i) => i.key)).toEqual([
      "p/a",
    ]);
  });

  it("offers new items within the daily limit, counting those started since the deck came", () => {
    const items = [card("p/a"), card("p/b"), card("p/c"), card("p/d", "mental-maths")];
    const d = deck(items, {
      limits: { daily_reviews: 40, daily_new: 3, weekly_minutes: 60, retention: 0.9 },
      progress: { reviews_today: 0, new_today: 1, minutes_this_week: 0 },
    });
    const fresh = (attempts: Attempt[], track: DeckItem["track"] = "review") =>
      queue(d, track, attempts, [], [], LATE_MONDAY, 0);
    expect(fresh([]).fresh.map((i) => i.key)).toEqual(["p/a", "p/b"]);
    expect(fresh([]).freshWaiting).toBe(1);
    // The limit is shared with other tracks, and an item started twice counts once.
    const started = [attempt("p/d", LATE_MONDAY - 60_000), attempt("p/d", LATE_MONDAY - 30_000)];
    expect(fresh(started).fresh.map((i) => i.key)).toEqual(["p/a"]);
    expect(fresh(started).freshWaiting).toBe(2);
    // The deck's count is only today's.
    const yesterday = deck(items, {
      ...d,
      day_start: dayStart(LATE_MONDAY, 0) - DAY_MS,
    });
    expect(queue(yesterday, "review", [], [], [], LATE_MONDAY, 0).fresh).toHaveLength(3);
    // A deck from an older Workshop, with no limit in it, isn't limited.
    const older = deck(items, {
      limits: { daily_reviews: 40, weekly_minutes: 60, retention: 0.9 },
      progress: { reviews_today: 0, minutes_this_week: 0 },
    });
    expect(queue(older, "review", [], [], [], LATE_MONDAY, 0).fresh).toHaveLength(3);
  });

  it("puts new items in the skills recent mistakes point to first", () => {
    const items = [
      { ...card("p/a"), skills: ["heaps"] },
      { ...card("p/b"), skills: ["graphs"] },
      { ...card("p/c"), skills: ["heaps"] },
    ];
    const d = deck(items, { focus: ["graphs"] });
    expect(queue(d, "review", [], [], [], LATE_MONDAY, 0).fresh.map((i) => i.key)).toEqual([
      "p/b",
      "p/a",
      "p/c",
    ]);
  });

  it("puts a card being followed up first, to carry on with", () => {
    const seen = (days: number) => review(null, LATE_MONDAY - days * DAY_MS, "good");
    const items = [
      card("p/a"),
      card("p/b"),
      card("p/c"),
      { ...card("p/new"), skills: ["heaps"] },
      card("p/deeper"),
    ];
    const d = deck(items, {
      schedules: { "p/a": seen(60), "p/b": seen(30), "p/c": seen(45) },
      limits: { daily_reviews: 2, weekly_minutes: 60, retention: 0.9 },
      focus: [],
    });
    const keys = (next: ReturnType<typeof queue>) => [...next.due, ...next.fresh].map((i) => i.key);
    expect(keys(queue(d, "review", [], [], [], LATE_MONDAY, 0))).toEqual([
      "p/a",
      "p/c",
      "p/new",
      "p/deeper",
    ]);
    // Even past today's limit, as it's started already.
    const due = { ...d, follow_ups: ["p/b"] };
    expect(keys(queue(due, "review", [], [], [], LATE_MONDAY, 0))).toEqual([
      "p/b",
      "p/a",
      "p/new",
      "p/deeper",
    ]);
    // Before even the skills recent mistakes point to.
    const fresh = { ...d, follow_ups: ["p/deeper"], focus: ["heaps"] };
    expect(queue(fresh, "review", [], [], [], LATE_MONDAY, 0).fresh.map((i) => i.key)).toEqual([
      "p/deeper",
      "p/new",
    ]);
  });

  it("leaves out flagged items until the flag is cleared", () => {
    const d = deck([card("p/a"), card("p/b")], { flags: { "p/a": { at: 1, note: null } } });
    expect(queue(d, "review", [], [], [], LATE_MONDAY, 0).fresh.map((i) => i.key)).toEqual(["p/b"]);
    const cleared = [{ id: newId(), item: "p/a", at: 2, flagged: false }];
    expect(flagged(d, cleared).has("p/a")).toBe(false);
    const again = [...cleared, { id: newId(), item: "p/b", at: 3, flagged: true }];
    expect([...flagged(d, again)]).toEqual(["p/b"]);
  });
});

describe("a track kept apart", () => {
  const drill = "pack:drill" as const;
  const kept = (changes: Partial<Deck> = {}) =>
    deck(
      [card("p/r1"), card("p/r2"), card("p/d1", drill), card("p/d2", drill), card("p/d3", drill)],
      {
        limits: { daily_reviews: 1, daily_new: 2, weekly_minutes: 60, retention: 0.9 },
        tracks: [
          { id: "review", name: "Review" },
          {
            id: drill,
            name: "Drill",
            kept_apart: true,
            progress: { reviews_today: 0, new_today: 1, minutes_this_week: 7 },
          },
        ],
        ...changes,
      },
    );

  it("has limits of its own, which the rest's don't touch, as on the server", () => {
    const d = kept({ progress: { reviews_today: 0, new_today: 2, minutes_this_week: 30 } });
    // The rest have used their new items today; the track has one of its own left.
    expect(queue(d, "review", [], [], [], LATE_MONDAY, 0).fresh).toHaveLength(0);
    const apart = queue(d, drill, [], [], [], LATE_MONDAY, 0);
    expect(apart.fresh.map((i) => i.key)).toEqual(["p/d1"]);
    expect(apart.freshWaiting).toBe(2);
    // What's done in it counts towards its own limits and time only.
    const done = [attempt("p/d1", LATE_MONDAY - 1000)];
    expect(queue(d, drill, done, [], [], LATE_MONDAY, 0).fresh).toHaveLength(0);
    expect(progress(d, done, LATE_MONDAY, 0)).toEqual({
      reviewsToday: 0,
      newToday: 2,
      minutesThisWeek: 30,
    });
    expect(progress(d, done, LATE_MONDAY, 0, drill)).toEqual({
      reviewsToday: 0,
      newToday: 2,
      minutesThisWeek: 7,
    });
  });

  it("spends its own limit of reviews on its own due items", () => {
    const seen = review(null, LATE_MONDAY - 30 * DAY_MS, "good");
    const d = kept({
      schedules: { "p/r1": seen, "p/r2": seen, "p/d1": seen, "p/d2": seen },
    });
    // One review a day each: the rest's goes on one of theirs, and the track's on one of its own.
    const rest = queue(d, "review", [], [], [], LATE_MONDAY, 0);
    expect(rest.due).toHaveLength(1);
    expect(rest.waiting).toBe(1);
    const apart = queue(d, drill, [], [], [], LATE_MONDAY, 0);
    expect(apart.due).toHaveLength(1);
    expect(apart.waiting).toBe(1);
  });
});

describe("progress", () => {
  it("adds what's been done to the deck's, unless the deck is from another day", () => {
    const d = deck([card("p/a"), card("p/b")], {
      progress: { reviews_today: 2, new_today: 4, minutes_this_week: 10 },
      schedules: { "p/a": review(null, LATE_MONDAY - 3 * DAY_MS, "good") },
    });
    const done = [attempt("p/a", LATE_MONDAY - 1000), attempt("p/b", LATE_MONDAY - 500)];
    // p/b is new, so only p/a's counts as a review, and p/b as a new item.
    expect(progress(d, done, LATE_MONDAY, 0)).toEqual({
      reviewsToday: 3,
      newToday: 5,
      minutesThisWeek: 11,
    });
    const tomorrow = LATE_MONDAY + DAY_MS;
    expect(progress(d, [], tomorrow, 0)).toEqual({
      reviewsToday: 0,
      newToday: 0,
      minutesThisWeek: 10,
    });
    expect(progress(d, [], LATE_MONDAY + 7 * DAY_MS, 0).minutesThisWeek).toBe(0);
  });
});

describe("step", () => {
  it("takes a few minutes' worth, due items first", () => {
    const long = { ...card("p/long"), minutes: 3 };
    const chosen = step({
      due: [card("p/due")],
      waiting: 0,
      fresh: [card("p/x"), card("p/y"), long],
      freshWaiting: 0,
    });
    expect(chosen.map((item) => item.key)).toEqual(["p/due", "p/x", "p/y"]);
    expect(
      step({ due: [], waiting: 0, fresh: [long, card("p/x")], freshWaiting: 0 }).map((i) => i.key),
    ).toEqual(["p/long"]);
  });
});

describe("nextInstance", () => {
  it("moves on to a question not yet asked, and starts again once they're used up", () => {
    const instances = [1, 2].map((seed) => ({
      seed,
      prompt: `Q${seed}`,
      answer: seed,
      method: null,
    }));
    expect(nextInstance(instances, [], "p/sum").seed).toBe(1);
    const once = [attempt("p/sum", 1), attempt("p/other", 2)];
    expect(nextInstance(instances, once, "p/sum").seed).toBe(2);
    const twice = [...once, attempt("p/sum", 3)];
    expect(nextInstance(instances, twice, "p/sum").seed).toBe(1);
  });
});

describe("newId", () => {
  it("makes UUIDs the server accepts", () => {
    const id = newId();
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(newId()).not.toBe(id);
  });
});

describe("retirements", () => {
  const change = (item: string, at: number, retired: boolean): RetirementChange => ({
    id: newId(),
    item,
    at,
    retired,
  });

  it("leave retired items out, from the deck or retired since it came", () => {
    const items = [card("p/a"), card("p/b"), card("p/c"), card("p/new"), card("p/gone")];
    const seen = review(null, LATE_MONDAY - 60 * DAY_MS, "good");
    const d = deck(items, {
      schedules: { "p/a": seen, "p/b": seen, "p/c": seen },
      retirements: { "p/a": { state: "retired", at: LATE_MONDAY - 50 * DAY_MS } },
    });
    const since = [change("p/b", LATE_MONDAY - 1000, true), change("p/gone", LATE_MONDAY, true)];
    const next = queue(d, "review", [], [], since, LATE_MONDAY, 0);
    expect(next.due.map((item) => item.key)).toEqual(["p/c"]);
    expect(next.fresh.map((item) => item.key)).toEqual(["p/new"]);
    expect(retired(d, "review", since).map((item) => item.key)).toEqual(["p/a", "p/b", "p/gone"]);
    expect(retired(d, "mental-maths", since)).toEqual([]);
  });

  it("make an item brought back due from then, as the server does", () => {
    const d = deck([card("p/a"), card("p/b")], {
      // Answered yesterday, so not due for days.
      schedules: {
        "p/a": review(null, LATE_MONDAY - DAY_MS, "easy"),
        "p/b": review(null, LATE_MONDAY - DAY_MS, "easy"),
      },
      retirements: { "p/a": { state: "retired", at: LATE_MONDAY - DAY_MS } },
    });
    expect(queue(d, "review", [], [], [], LATE_MONDAY, 0).due).toEqual([]);
    const back = [change("p/a", LATE_MONDAY - 60_000, false)];
    const next = queue(d, "review", [], [], back, LATE_MONDAY, 0);
    expect(next.due.map((item) => item.key)).toEqual(["p/a"]);
    expect(retired(d, "review", back)).toEqual([]);
    // Once it's done again, its schedule says when it's due.
    const again = [attempt("p/a", LATE_MONDAY - 30_000)];
    expect(queue(d, "review", again, [], back, LATE_MONDAY, 0).due).toEqual([]);
  });
});
