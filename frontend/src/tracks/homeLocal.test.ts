import { describe, expect, it } from "vitest";
import type { Attempt, Deck } from "../learning/types";
import { homeSnapshotKey, patchHome } from "./homeLocal";
import type { Home } from "./types";

const NOW = 1_790_000_000_000;

const DECK: Deck = {
  limits: { daily_reviews: 40, daily_new: 10, weekly_minutes: 90, retention: 0.9 },
  progress: { reviews_today: 0, new_today: 0, minutes_this_week: 5 },
  day_start: Math.floor(NOW / 86_400_000) * 86_400_000,
  week_start: Math.floor(NOW / 86_400_000) * 86_400_000,
  tracks: [{ id: "review", name: "Review" }],
  items: [
    {
      key: "sample/card-1",
      track: "review",
      label: "Card 1",
      skills: ["s"],
      prompt: "Q?",
      source: null,
      minutes: 1,
      kind: "card",
      answer: "A",
      explanation: null,
    },
    {
      key: "sample/read-1",
      track: "coding",
      label: "Read 1",
      skills: ["s"],
      prompt: "Code?",
      source: null,
      minutes: 2,
      kind: "reading",
      language: "python",
      ask: "prints",
      output: "1",
      explanation: "Because.",
    },
  ],
  schedules: {},
  flags: {},
  retirements: {},
  skills: [],
  focus: [],
  problems: [],
};

const SNAPSHOT: Home = {
  continue: {
    track: "review",
    long: false,
    title: "Card 1",
    reason: "Something new",
    priority: "new",
    destination: { kind: "practice", track: "review" },
  },
  tracks: [
    {
      id: "advent-of-code",
      name: "Advent of Code",
      icon: "star",
      summary: "2024 Day 1",
      destination: { kind: "puzzle_list" },
      next: null,
      long: null,
      in_continue: true,
    },
    {
      id: "review",
      name: "Review",
      icon: "history",
      summary: "1 new",
      destination: { kind: "practice", track: "review" },
      next: null,
      long: null,
      in_continue: true,
    },
  ],
  week: { minutes: 5, target: 90 },
  problems: [],
};

describe("homeLocal", () => {
  it("keys snapshots by aWhile and UTC offset", () => {
    expect(homeSnapshotKey(false, 0)).toBe("home:short:0");
    expect(homeSnapshotKey(true, 60)).toBe("home:a_while:60");
  });

  it("updates weekly minutes, short-item summaries, and drops completed Continue targets", () => {
    const attempt: Attempt = {
      id: "a1",
      item: "sample/card-1",
      answered_at: NOW,
      duration_ms: 120_000,
      rating: "good",
    };
    const patched = patchHome(SNAPSHOT, DECK, [attempt], [], [], NOW, 0);
    expect(patched.week?.minutes).toBe(7);
    expect(patched.tracks.find((t) => t.id === "review")?.summary).toBe("All caught up for now");
    expect(patched.tracks.find((t) => t.id === "advent-of-code")?.summary).toBe("2024 Day 1");
    expect(patched.continue).toBeNull();
  });

  it("keeps a card being followed up to carry on with, past today's limits", () => {
    const spent = {
      ...DECK,
      progress: { reviews_today: 0, new_today: 10, minutes_this_week: 5 },
      follow_ups: ["sample/card-1"],
    };
    // Patched as something else was done offline.
    const elsewhere: Attempt = {
      id: "a2",
      item: "sample/read-1",
      answered_at: NOW,
      duration_ms: 60_000,
      rating: "good",
    };
    const patched = patchHome(SNAPSHOT, spent, [elsewhere], [], [], NOW, 0);
    expect(patched.tracks.find((t) => t.id === "review")?.summary).toBe("1 being followed up");
    expect(patched.continue?.track).toBe("review");
  });

  it("drops Continue when a reading item in Coding was retired locally", () => {
    const withReading: Home = {
      ...SNAPSHOT,
      continue: {
        track: "coding",
        long: false,
        title: "Read 1",
        reason: "Something new",
        priority: "new",
        destination: { kind: "coding", item: "sample/read-1" },
      },
    };
    const patched = patchHome(
      withReading,
      DECK,
      [],
      [],
      [{ id: "r1", item: "sample/read-1", at: NOW, retired: true }],
      NOW,
      0,
    );
    expect(patched.continue).toBeNull();
  });

  it("updates lesson summaries, weekly minutes, and drops completed or skipped Continue lessons", () => {
    const withLessonDeck: Deck = {
      ...DECK,
      limits: { ...DECK.limits, daily_lessons: 1 },
      lessons: [
        {
          key: "sample/heaps",
          track: "review",
          title: "Heaps",
          skills: ["s"],
          prompt: "About heaps",
          source: null,
          minutes: 4,
          requires: [],
          sources: [{ title: "Docs", url: "https://example.com" }],
          guesses: [],
          segments: [{ title: "One", body: "Body", check: null }],
          explain: "Why?",
          explain_answer: "Because.",
          images: {},
        },
      ],
    };
    const withLessonContinue: Home = {
      ...SNAPSHOT,
      continue: {
        track: "review",
        long: false,
        title: "Heaps",
        reason: "Lesson",
        priority: "new",
        destination: { kind: "lesson", item: "sample/heaps" },
      },
    };
    const completed = patchHome(
      withLessonContinue,
      withLessonDeck,
      [],
      [],
      [],
      NOW,
      0,
      [{ id: "c1", lesson: "sample/heaps", completed_at: NOW, duration_ms: 180_000 }],
      [],
    );
    expect(completed.week?.minutes).toBe(8);
    expect(completed.tracks.find((t) => t.id === "review")?.summary).toBe("1 new");
    expect(completed.continue).toBeNull();

    const skipped = patchHome(
      withLessonContinue,
      withLessonDeck,
      [],
      [],
      [],
      NOW,
      0,
      [],
      [{ id: "s1", lesson: "sample/heaps", skipped_at: NOW }],
    );
    expect(skipped.tracks.find((t) => t.id === "review")?.summary).toBe("1 new");
    expect(skipped.continue).toBeNull();
  });
});
