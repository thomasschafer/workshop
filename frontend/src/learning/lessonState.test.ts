import { describe, expect, it } from "vitest";
import {
  advanceFromSegment,
  answerGuess,
  answerSegmentCheck,
  clampProgress,
  clearLessonProgress,
  enterRecap,
  goToSegment,
  initialProgress,
  loadLessonProgress,
  saveLessonProgress,
  startLesson,
} from "./lessonState";
import type { DeckLesson } from "./types";

class MemoryStorage implements Storage {
  private readonly map = new Map<string, string>();
  get length() {
    return this.map.size;
  }
  clear() {
    this.map.clear();
  }
  getItem(key: string) {
    return this.map.get(key) ?? null;
  }
  key(index: number) {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.map.delete(key);
  }
  setItem(key: string, value: string) {
    this.map.set(key, value);
  }
}

function makeLesson(overrides: Partial<DeckLesson> = {}): DeckLesson {
  return {
    key: "sample/binary-heaps",
    track: "review",
    title: "How a binary heap works",
    skills: ["data-structures"],
    prompt: "Overview",
    source: null,
    minutes: 4,
    requires: [],
    sources: [{ title: "Docs", url: "https://example.com" }],
    guesses: [
      { prompt: "G1", choices: ["A", "B"], answer: 1 },
      { prompt: "G2", choices: ["C", "D"], answer: 0 },
    ],
    segments: [
      {
        title: "One",
        body: "Body 1",
        check: { prompt: "C1", choices: ["X", "Y"], answer: 1, explanation: "Because Y." },
      },
      { title: "Two", body: "Body 2", check: null },
    ],
    explain: "Explain why.",
    explain_answer: "Because of completeness.",
    images: {},
    ...overrides,
  };
}

describe("lessonState", () => {
  it("walks from opening through guesses, segments, explain, and recap", () => {
    const lesson = makeLesson();
    let p = initialProgress();
    expect(p.stage).toEqual({ kind: "opening" });

    p = startLesson(lesson, p);
    expect(p.stage).toEqual({ kind: "guess", index: 0 });

    p = answerGuess(lesson, p, 0, 1);
    expect(p.stage).toEqual({ kind: "guess", index: 1 });
    expect(p.guesses[0]).toBe(1);

    p = answerGuess(lesson, p, 1, null);
    expect(p.stage).toEqual({ kind: "segment", index: 0 });
    expect(p.guesses[1]).toBeNull();

    p = answerSegmentCheck(p, 0, 0);
    // Answering a check twice keeps the first choice.
    p = answerSegmentCheck(p, 0, 1);
    expect(p.checks[0]).toBe(0);

    p = advanceFromSegment(lesson, p, 0);
    expect(p.stage).toEqual({ kind: "segment", index: 1 });
    expect(p.reachedSegment).toBe(1);

    // Earlier segments can be revisited, and forward navigation stays within reachedSegment.
    p = goToSegment(lesson, p, 0);
    expect(p.stage).toEqual({ kind: "segment", index: 0 });
    p = goToSegment(lesson, p, 99);
    expect(p.stage).toEqual({ kind: "segment", index: 1 });

    p = advanceFromSegment(lesson, p, 1);
    expect(p.stage).toEqual({ kind: "explain" });

    let ids = 0;
    const firstRecap = enterRecap(p, () => `comp-${++ids}`);
    expect(firstRecap.newlyCompletedId).toBe("comp-1");
    expect(firstRecap.next.stage).toEqual({ kind: "recap" });
    expect(firstRecap.next.completionId).toBe("comp-1");

    // Entering recap again for the same run does not emit a duplicate completion.
    const secondRecap = enterRecap(firstRecap.next, () => `comp-${++ids}`);
    expect(secondRecap.newlyCompletedId).toBeNull();
    expect(secondRecap.next.completionId).toBe("comp-1");
  });

  it("skips straight to the first segment when a lesson has no guesses", () => {
    const lesson = makeLesson({ guesses: [] });
    const p = startLesson(lesson, initialProgress());
    expect(p.stage).toEqual({ kind: "segment", index: 0 });
  });

  it("persists progress in storage and clamps if the lesson shrinks", () => {
    const storage = new MemoryStorage();
    const lesson = makeLesson();
    const saved = advanceFromSegment(
      lesson,
      startLesson(makeLesson({ guesses: [] }), initialProgress()),
      0,
    );
    saveLessonProgress(lesson.key, saved, storage);
    expect(loadLessonProgress(lesson, storage)).toEqual(saved);

    const smaller = makeLesson({
      guesses: [],
      segments: [{ title: "Only", body: "Body", check: null }],
    });
    const clamped = clampProgress(smaller, saved);
    expect(clamped.stage).toEqual({ kind: "segment", index: 0 });
    expect(clamped.reachedSegment).toBe(0);

    clearLessonProgress(lesson.key, storage);
    expect(loadLessonProgress(lesson, storage)).toEqual(initialProgress());
  });
});
