// Pure state transitions and local persistence for a lesson in progress.

import type { Marked } from "../grading/types";
import type { DeckLesson } from "./types";

export type LessonStage =
  | { kind: "opening" }
  | { kind: "guess"; index: number }
  | { kind: "segment"; index: number }
  | { kind: "explain" }
  | { kind: "recap" };

export interface LessonProgress {
  stage: LessonStage;
  /** For each guess (by index): chosen choice index, or null for "Not sure". */
  guesses: Record<number, number | null>;
  /** For each segment (by index) with a check: chosen choice index once answered. */
  checks: Record<number, number>;
  /** Highest segment index reached, so earlier segments can be revisited. */
  reachedSegment: number;
  /** The learner's draft or submitted explanation text. */
  explainText: string;
  /** Whether the explanation was given aloud. */
  explainSpoken: boolean;
  /** Grader result if marked online. */
  marked: Marked | null;
  /** Whether the explain answer has been revealed (by grading or choosing to compare). */
  explainRevealed: boolean;
  /** Id of the LessonCompletion recorded on reaching recap, preventing duplicates on reload. */
  completionId: string | null;
}

const STORAGE_PREFIX = "workshop:lesson:";

export function progressKey(lessonKey: string): string {
  return `${STORAGE_PREFIX}${lessonKey}`;
}

export function initialProgress(): LessonProgress {
  return {
    stage: { kind: "opening" },
    guesses: {},
    checks: {},
    reachedSegment: 0,
    explainText: "",
    explainSpoken: false,
    marked: null,
    explainRevealed: false,
    completionId: null,
  };
}

/** Clamps saved progress to a lesson's current shape in case the pack changed since saving. */
export function clampProgress(lesson: DeckLesson, saved: LessonProgress): LessonProgress {
  const maxSegment = Math.max(0, lesson.segments.length - 1);
  const reachedSegment = Math.min(Math.max(0, saved.reachedSegment), maxSegment);
  let stage: LessonStage = saved.stage;
  if (stage.kind === "guess") {
    if (lesson.guesses.length === 0) {
      stage = { kind: "segment", index: 0 };
    } else if (stage.index < 0 || stage.index >= lesson.guesses.length) {
      stage = { kind: "segment", index: 0 };
    }
  } else if (stage.kind === "segment") {
    if (lesson.segments.length === 0) {
      stage = { kind: "explain" };
    } else {
      stage = { kind: "segment", index: Math.min(Math.max(0, stage.index), maxSegment) };
    }
  }
  return { ...saved, stage, reachedSegment };
}

export function loadLessonProgress(
  lesson: DeckLesson,
  storage: Storage = localStorage,
): LessonProgress {
  try {
    const raw = storage.getItem(progressKey(lesson.key));
    if (!raw) return initialProgress();
    const parsed = JSON.parse(raw) as Partial<LessonProgress>;
    if (!parsed || typeof parsed !== "object" || !parsed.stage) return initialProgress();
    return clampProgress(lesson, { ...initialProgress(), ...parsed });
  } catch {
    return initialProgress();
  }
}

export function saveLessonProgress(
  lessonKey: string,
  progress: LessonProgress,
  storage: Storage = localStorage,
): void {
  try {
    storage.setItem(progressKey(lessonKey), JSON.stringify(progress));
  } catch {
    // Storage may be full or unavailable; in-memory state still works.
  }
}

export function clearLessonProgress(lessonKey: string, storage: Storage = localStorage): void {
  try {
    storage.removeItem(progressKey(lessonKey));
  } catch {
    // Ignore storage failures.
  }
}

/** Moves from the opening into the first guess, or straight to the first segment if there are none. */
export function startLesson(lesson: DeckLesson, progress: LessonProgress): LessonProgress {
  if (lesson.guesses.length > 0) {
    return { ...progress, stage: { kind: "guess", index: 0 } };
  }
  return { ...progress, stage: { kind: "segment", index: 0 }, reachedSegment: 0 };
}

/** Records a guess (or null for "Not sure") and advances without showing feedback. */
export function answerGuess(
  lesson: DeckLesson,
  progress: LessonProgress,
  guessIndex: number,
  choice: number | null,
): LessonProgress {
  const guesses = { ...progress.guesses, [guessIndex]: choice };
  const nextIndex = guessIndex + 1;
  if (nextIndex < lesson.guesses.length) {
    return { ...progress, guesses, stage: { kind: "guess", index: nextIndex } };
  }
  return {
    ...progress,
    guesses,
    stage: { kind: "segment", index: 0 },
    reachedSegment: Math.max(progress.reachedSegment, 0),
  };
}

/** Records the learner's choice on a segment's check (once only). */
export function answerSegmentCheck(
  progress: LessonProgress,
  segmentIndex: number,
  choice: number,
): LessonProgress {
  if (progress.checks[segmentIndex] !== undefined) return progress;
  return {
    ...progress,
    checks: { ...progress.checks, [segmentIndex]: choice },
  };
}

/** Moves to another reached segment, such as going back to review an earlier one. */
export function goToSegment(
  lesson: DeckLesson,
  progress: LessonProgress,
  index: number,
): LessonProgress {
  const clamped = Math.min(
    Math.max(0, index),
    Math.min(progress.reachedSegment, lesson.segments.length - 1),
  );
  return { ...progress, stage: { kind: "segment", index: clamped } };
}

/** Advances from a segment to the next segment, or to the explain step after the last segment. */
export function advanceFromSegment(
  lesson: DeckLesson,
  progress: LessonProgress,
  segmentIndex: number,
): LessonProgress {
  const nextIndex = segmentIndex + 1;
  if (nextIndex < lesson.segments.length) {
    return {
      ...progress,
      stage: { kind: "segment", index: nextIndex },
      reachedSegment: Math.max(progress.reachedSegment, nextIndex),
    };
  }
  return { ...progress, stage: { kind: "explain" } };
}

/** Moves to the recap stage, stamping a completion id if one hasn't been recorded yet. */
export function enterRecap(
  progress: LessonProgress,
  makeId: () => string,
): { next: LessonProgress; newlyCompletedId: string | null } {
  if (progress.completionId !== null) {
    return { next: { ...progress, stage: { kind: "recap" } }, newlyCompletedId: null };
  }
  const id = makeId();
  return {
    next: { ...progress, stage: { kind: "recap" }, completionId: id },
    newlyCompletedId: id,
  };
}
