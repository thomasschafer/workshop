import { describe, expect, it } from "vitest";
import { dayStart, flagged, newId, nextInstance, progress, queue, step, weekStart } from "./local";
import { DAY_MS, review } from "./schedule";
import type { Attempt, Deck, DeckItem } from "./types";

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
    limits: { daily_reviews: 40, weekly_minutes: 60, retention: 0.9 },
    progress: { reviews_today: 0, minutes_this_week: 0 },
    day_start: dayStart(LATE_MONDAY, 0),
    week_start: weekStart(LATE_MONDAY, 0),
    tracks: [],
    items,
    schedules: {},
    flags: {},
    skills: [],
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
    const next = queue(d, "review", [], [], LATE_MONDAY, 0);
    // Two reviews left today, and p/sum in another track is the most overdue.
    expect(next.due.map((item) => item.key)).toEqual(["p/b"]);
    expect(next.waiting).toBe(2);
    expect(next.fresh.map((item) => item.key)).toEqual(["p/new"]);
  });

  it("takes what's been done since the deck came into account", () => {
    const d = deck([card("p/a"), card("p/b")]);
    const done = [attempt("p/a", LATE_MONDAY - 60_000, "good")];
    const next = queue(d, "review", done, [], LATE_MONDAY, 0);
    expect(next.due).toEqual([]);
    expect(next.fresh.map((item) => item.key)).toEqual(["p/b"]);
    // Forgotten, it comes back ten minutes later.
    const forgotten = [attempt("p/a", LATE_MONDAY - 11 * 60_000, "again")];
    expect(queue(d, "review", forgotten, [], LATE_MONDAY, 0).due.map((i) => i.key)).toEqual([
      "p/a",
    ]);
  });

  it("leaves out flagged items until the flag is cleared", () => {
    const d = deck([card("p/a"), card("p/b")], { flags: { "p/a": { at: 1, note: null } } });
    expect(queue(d, "review", [], [], LATE_MONDAY, 0).fresh.map((i) => i.key)).toEqual(["p/b"]);
    const cleared = [{ id: newId(), item: "p/a", at: 2, flagged: false }];
    expect(flagged(d, cleared).has("p/a")).toBe(false);
    const again = [...cleared, { id: newId(), item: "p/b", at: 3, flagged: true }];
    expect([...flagged(d, again)]).toEqual(["p/b"]);
  });
});

describe("progress", () => {
  it("adds what's been done to the deck's, unless the deck is from another day", () => {
    const d = deck([card("p/a"), card("p/b")], {
      progress: { reviews_today: 2, minutes_this_week: 10 },
      schedules: { "p/a": review(null, LATE_MONDAY - 3 * DAY_MS, "good") },
    });
    const done = [attempt("p/a", LATE_MONDAY - 1000), attempt("p/b", LATE_MONDAY - 500)];
    // p/b is new, so only p/a's counts as a review.
    expect(progress(d, done, LATE_MONDAY, 0)).toEqual({ reviewsToday: 3, minutesThisWeek: 11 });
    const tomorrow = LATE_MONDAY + DAY_MS;
    expect(progress(d, [], tomorrow, 0)).toEqual({ reviewsToday: 0, minutesThisWeek: 10 });
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
    });
    expect(chosen.map((item) => item.key)).toEqual(["p/due", "p/x", "p/y"]);
    expect(step({ due: [], waiting: 0, fresh: [long, card("p/x")] }).map((i) => i.key)).toEqual([
      "p/long",
    ]);
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
