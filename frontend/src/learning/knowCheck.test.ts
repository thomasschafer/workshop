import { describe, expect, it } from "vitest";
import type { Marked } from "../grading/types";
import {
  advanceKnowCheck,
  answerKnowCheck,
  checkedSegments,
  clampKnowCheck,
  KNOW_CHECK_PASS_SCORE,
  type KnowCheck,
  knowCheckPassed,
  markKnowCheck,
  missedSegments,
  offersKnowCheck,
  startKnowCheck,
} from "./knowCheck";
import {
  beginKnowCheck,
  initialProgress,
  lessonAfterKnowCheck,
  loadLessonProgress,
  saveLessonProgress,
  stampCompletion,
  updateKnowCheck,
} from "./lessonState";
import type { DeckLesson, DeckLessonCheck } from "./types";

function check(answer: number): DeckLessonCheck {
  return { prompt: `Pick ${answer}`, choices: ["A", "B", "C"], answer, explanation: "Because." };
}

/** Three segments, the first and third with checks whose right answers are 1 and 2. */
function makeLesson(overrides: Partial<DeckLesson> = {}): DeckLesson {
  return {
    key: "sample/binary-heaps",
    track: "review",
    title: "How a binary heap works",
    skills: [],
    prompt: "Overview",
    source: null,
    minutes: 4,
    requires: [],
    sources: [{ title: "Docs", url: "https://example.com" }],
    guesses: [{ prompt: "G1", choices: ["A", "B"], answer: 1 }],
    segments: [
      { title: "One", body: "Body 1", check: check(1) },
      { title: "Two", body: "Body 2", check: null },
      { title: "Three", body: "Body 3", check: check(2) },
    ],
    explain: "Explain why.",
    explain_answer: "Because of completeness.",
    images: {},
    ...overrides,
  };
}

function marked(score: number): Marked {
  return {
    score,
    points: [],
    findings: [],
    feedback: "Feedback.",
    clarity: null,
    questioning: null,
  };
}

/** A check with each checked segment answered as given, at the explain step. */
function answered(answers: Record<number, number>): KnowCheck {
  return { stage: { kind: "explain" }, answers, explainText: "Because.", marked: null };
}

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

describe("knowCheckPassed", () => {
  const lesson = makeLesson();

  it("passes with every check right and an explanation marked at the threshold or above", () => {
    expect(knowCheckPassed(lesson, { 0: 1, 2: 2 }, marked(KNOW_CHECK_PASS_SCORE))).toBe(true);
    expect(knowCheckPassed(lesson, { 0: 1, 2: 2 }, marked(1))).toBe(true);
  });

  it("doesn't pass with an explanation marked below the threshold", () => {
    expect(knowCheckPassed(lesson, { 0: 1, 2: 2 }, marked(KNOW_CHECK_PASS_SCORE - 0.01))).toBe(
      false,
    );
    expect(knowCheckPassed(lesson, { 0: 1, 2: 2 }, marked(0))).toBe(false);
  });

  it("doesn't pass with a check missed, however well explained", () => {
    expect(knowCheckPassed(lesson, { 0: 0, 2: 2 }, marked(1))).toBe(false);
    expect(knowCheckPassed(lesson, { 0: 1, 2: 0 }, marked(1))).toBe(false);
  });

  it("doesn't pass with a check unanswered, or without a mark", () => {
    expect(knowCheckPassed(lesson, { 0: 1 }, marked(1))).toBe(false);
    expect(knowCheckPassed(lesson, { 0: 1, 2: 2 }, null)).toBe(false);
  });

  it("is the threshold at which the grader rates other work Good", () => {
    expect(KNOW_CHECK_PASS_SCORE).toBe(0.85);
  });

  it("doesn't pass a lesson with too few checks to check", () => {
    const one = makeLesson({
      segments: [
        { title: "One", body: "Body 1", check: check(1) },
        { title: "Two", body: "Body 2", check: null },
      ],
    });
    expect(offersKnowCheck(one)).toBe(false);
    expect(knowCheckPassed(one, { 0: 1 }, marked(1))).toBe(false);
    expect(() => startKnowCheck(one)).toThrow();
  });
});

describe("the know check", () => {
  const lesson = makeLesson();

  it("asks each check once, then the explanation, and passes with a good mark", () => {
    expect(checkedSegments(lesson)).toEqual([0, 2]);
    expect(offersKnowCheck(lesson)).toBe(true);
    let c = startKnowCheck(lesson);
    expect(c.stage).toEqual({ kind: "check", index: 0 });

    // Can't move on before answering, and answering twice keeps the first choice.
    expect(advanceKnowCheck(lesson, c)).toBe(c);
    c = answerKnowCheck(lesson, c, 1);
    c = answerKnowCheck(lesson, c, 0);
    expect(c.answers).toEqual({ 0: 1 });

    c = advanceKnowCheck(lesson, c);
    expect(c.stage).toEqual({ kind: "check", index: 1 });
    c = advanceKnowCheck(lesson, answerKnowCheck(lesson, c, 2));
    expect(c.stage).toEqual({ kind: "explain" });

    // Marks only count at the explain step.
    expect(markKnowCheck(lesson, startKnowCheck(lesson), marked(1)).stage.kind).toBe("check");
    expect(markKnowCheck(lesson, c, marked(0.9)).stage).toEqual({ kind: "passed" });
    const poor = markKnowCheck(lesson, c, marked(0.6));
    expect(poor.stage).toEqual({ kind: "missed" });
    expect(poor.marked?.score).toBe(0.6);
    expect(missedSegments(lesson, poor)).toEqual([]);
  });

  it("goes straight to what was missed, without an explanation, once a check is missed", () => {
    let c = startKnowCheck(lesson);
    c = advanceKnowCheck(lesson, answerKnowCheck(lesson, c, 1));
    c = advanceKnowCheck(lesson, answerKnowCheck(lesson, c, 0));
    expect(c.stage).toEqual({ kind: "missed" });
    expect(missedSegments(lesson, c)).toEqual([2]);
  });

  it("starts the lesson at the first segment with a missed check, keeping checks answered right", () => {
    let p = beginKnowCheck(lesson, initialProgress());
    p = updateKnowCheck(p, () => ({ ...answered({ 0: 1, 2: 0 }), stage: { kind: "missed" } }));
    const started = lessonAfterKnowCheck(lesson, p);
    expect(started.knowCheck).toBeNull();
    expect(started.stage).toEqual({ kind: "segment", index: 2 });
    expect(started.reachedSegment).toBe(2);
    expect(started.checks).toEqual({ 0: 1 });
  });

  it("starts the lesson from the start when only the explanation fell short", () => {
    let p = beginKnowCheck(lesson, initialProgress());
    p = updateKnowCheck(p, () => markKnowCheck(lesson, answered({ 0: 1, 2: 2 }), marked(0.5)));
    const started = lessonAfterKnowCheck(lesson, p);
    expect(started.knowCheck).toBeNull();
    expect(started.stage).toEqual({ kind: "guess", index: 0 });
    expect(started.checks).toEqual({ 0: 1, 2: 2 });
  });

  it("records a completion only once when passed", () => {
    const p = beginKnowCheck(lesson, initialProgress());
    let ids = 0;
    const first = stampCompletion(p, () => `c-${++ids}`);
    expect(first.newlyCompletedId).toBe("c-1");
    expect(stampCompletion(first.next, () => `c-${++ids}`).newlyCompletedId).toBeNull();
  });

  it("is saved with the lesson's progress, and resumes where it was", () => {
    const storage = new MemoryStorage();
    let p = beginKnowCheck(lesson, initialProgress());
    p = updateKnowCheck(p, (c) => advanceKnowCheck(lesson, answerKnowCheck(lesson, c, 1)));
    saveLessonProgress(lesson.key, p, storage);
    const loaded = loadLessonProgress(lesson, storage);
    expect(loaded.knowCheck?.stage).toEqual({ kind: "check", index: 1 });
    expect(loaded.knowCheck?.answers).toEqual({ 0: 1 });
    // Saved before checks existed, progress has none under way.
    storage.setItem(
      "workshop:lesson:sample/binary-heaps",
      JSON.stringify({ stage: { kind: "opening" } }),
    );
    expect(loadLessonProgress(lesson, storage).knowCheck).toBeNull();
  });

  it("fits a saved check to a lesson that's changed, or drops it", () => {
    // A check whose segment lost its check, or an answer out of range, is dropped, and an
    // explain step with a check now unanswered goes back to that check.
    const changed = makeLesson({
      segments: [
        { title: "One", body: "Body 1", check: check(1) },
        { title: "Two", body: "Body 2", check: check(0) },
        { title: "Three", body: "Body 3", check: null },
      ],
    });
    const clamped = clampKnowCheck(changed, answered({ 0: 1, 2: 2 }));
    expect(clamped?.answers).toEqual({ 0: 1 });
    expect(clamped?.stage).toEqual({ kind: "check", index: 1 });
    expect(clampKnowCheck(changed, answered({ 0: 7, 1: 0 }))?.answers).toEqual({ 1: 0 });
    expect(
      clampKnowCheck(changed, { ...answered({}), stage: { kind: "check", index: 9 } })?.stage,
    ).toEqual({ kind: "check", index: 1 });
    // A lesson left with fewer than two checks has nothing to check.
    const one = makeLesson({ segments: [{ title: "One", body: "Body 1", check: check(1) }] });
    expect(clampKnowCheck(one, answered({ 0: 1 }))).toBeNull();
  });
});
