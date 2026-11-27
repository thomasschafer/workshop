// "I know this": a short check of what a lesson teaches, which counts the lesson as done when
// passed, instead of sitting through it. Pure state transitions; the progress is kept with the
// lesson's own in lessonState.

import type { Marked } from "../grading/types";
import type { DeckLesson } from "./types";

/**
 * The lowest grader score that passes the explain step. It's the score at which the grader's
 * mark of other work counts as Good for scheduling (`Marked::rating` in src/grader.rs): an
 * explanation recalled soundly, rather than with difficulty.
 */
export const KNOW_CHECK_PASS_SCORE = 0.85;

/** A lesson with fewer checks than this is too little to check, so doesn't offer "I know this". */
export const KNOW_CHECK_MIN_CHECKS = 2;

export type KnowCheckStage =
  /** Answering the `index`th of the lesson's checks, counting only segments with one. */
  { kind: "check"; index: number } | { kind: "explain" } | { kind: "passed" } | { kind: "missed" };

export interface KnowCheck {
  stage: KnowCheckStage;
  /** For each segment (by index) whose check has been answered, the chosen choice. */
  answers: Record<number, number>;
  /** The learner's draft or submitted explanation. */
  explainText: string;
  /** The grader's mark of the explanation, once marked. */
  marked: Marked | null;
}

/** The indices of the lesson's segments that have a check, in order. */
export function checkedSegments(lesson: DeckLesson): number[] {
  return lesson.segments.flatMap((segment, index) => (segment.check ? [index] : []));
}

export function offersKnowCheck(lesson: DeckLesson): boolean {
  return checkedSegments(lesson).length >= KNOW_CHECK_MIN_CHECKS;
}

export function startKnowCheck(lesson: DeckLesson): KnowCheck {
  if (!offersKnowCheck(lesson)) {
    throw new Error(`${lesson.key} has too few checks to offer "I know this"`);
  }
  return { stage: { kind: "check", index: 0 }, answers: {}, explainText: "", marked: null };
}

/** The segments whose checks were answered wrong, in order. */
export function missedSegments(lesson: DeckLesson, check: KnowCheck): number[] {
  return checkedSegments(lesson).filter((segment) => {
    const answer = check.answers[segment];
    return answer !== undefined && answer !== lesson.segments[segment]?.check?.answer;
  });
}

/** Whether every check was answered right and the explanation marked as sound. */
export function knowCheckPassed(
  lesson: DeckLesson,
  answers: Record<number, number>,
  marked: Marked | null,
): boolean {
  const segments = checkedSegments(lesson);
  const allRight = segments.every(
    (segment) => answers[segment] === lesson.segments[segment]?.check?.answer,
  );
  return (
    segments.length >= KNOW_CHECK_MIN_CHECKS &&
    allRight &&
    marked !== null &&
    marked.score >= KNOW_CHECK_PASS_SCORE
  );
}

/** Records the answer to the check being asked, once only. */
export function answerKnowCheck(lesson: DeckLesson, check: KnowCheck, choice: number): KnowCheck {
  if (check.stage.kind !== "check") return check;
  const segment = checkedSegments(lesson)[check.stage.index];
  if (segment === undefined || check.answers[segment] !== undefined) return check;
  return { ...check, answers: { ...check.answers, [segment]: choice } };
}

/**
 * Moves on from an answered check: to the next one, or after the last to the explain step. With
 * a check missed the explanation can't change the outcome, so it goes straight to what was missed
 * rather than asking for one.
 */
export function advanceKnowCheck(lesson: DeckLesson, check: KnowCheck): KnowCheck {
  if (check.stage.kind !== "check") return check;
  const segments = checkedSegments(lesson);
  const segment = segments[check.stage.index];
  if (segment === undefined || check.answers[segment] === undefined) return check;
  const next = check.stage.index + 1;
  if (next < segments.length) return { ...check, stage: { kind: "check", index: next } };
  if (missedSegments(lesson, check).length > 0) return { ...check, stage: { kind: "missed" } };
  return { ...check, stage: { kind: "explain" } };
}

/** Takes the grader's mark of the explanation, and with it whether the check was passed. */
export function markKnowCheck(lesson: DeckLesson, check: KnowCheck, marked: Marked): KnowCheck {
  if (check.stage.kind !== "explain") return check;
  return {
    ...check,
    marked,
    stage: { kind: knowCheckPassed(lesson, check.answers, marked) ? "passed" : "missed" },
  };
}

/** Where the lesson starts after a check not passed: its first segment with a missed check. */
export function lessonStartAfterMiss(lesson: DeckLesson, check: KnowCheck): number | null {
  return missedSegments(lesson, check)[0] ?? null;
}

/** Fits a saved check to the lesson's current shape, or drops it, in case the pack changed. */
export function clampKnowCheck(lesson: DeckLesson, saved: KnowCheck | null): KnowCheck | null {
  if (saved === null || !offersKnowCheck(lesson)) return null;
  const segments = checkedSegments(lesson);
  const answers: Record<number, number> = {};
  for (const segment of segments) {
    const answer = saved.answers?.[segment];
    const choices = lesson.segments[segment]?.check?.choices.length ?? 0;
    if (typeof answer === "number" && answer >= 0 && answer < choices) answers[segment] = answer;
  }
  let stage = saved.stage;
  if (stage.kind === "check") {
    stage = { kind: "check", index: Math.min(Math.max(0, stage.index), segments.length - 1) };
  } else if (stage.kind === "explain" || stage.kind === "passed") {
    // Every check must still be answered for these, or the check starts again where it's short.
    const unanswered = segments.findIndex((segment) => answers[segment] === undefined);
    if (unanswered !== -1) stage = { kind: "check", index: unanswered };
  }
  return {
    stage,
    answers,
    explainText: typeof saved.explainText === "string" ? saved.explainText : "",
    marked: saved.marked ?? null,
  };
}
