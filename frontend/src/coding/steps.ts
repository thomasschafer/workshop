import type { Rating } from "../learning/types";
import type { CaseRef, Mode, Run, Session, StepName, TwistKind } from "./types";

const STEPS: Record<Mode, StepName[]> = {
  solve: ["understand", "plan", "code", "test", "review"],
  recall: ["plan", "review"],
  twist: ["twist"],
};

export function stepsFor(mode: Mode): StepName[] {
  return STEPS[mode];
}

export const STEP_LABELS: Record<StepName, string> = {
  understand: "Understand",
  plan: "Plan",
  code: "Code",
  test: "Test",
  review: "Review",
  twist: "Twist",
};

export const TWIST_KINDS: Record<TwistKind, string> = {
  constraint: "A new constraint",
  scale: "At a larger scale",
  streaming: "Streaming",
  complexity: "A better complexity",
  edge_case: "Different edge cases",
};

/** The step after this one, or null at the end. */
export function stepAfter(mode: Mode, step: StepName): StepName | null {
  const steps = STEPS[mode];
  return steps[steps.indexOf(step) + 1] ?? null;
}

/** Whether a step can be gone back to from where the learner is: any that's been done. */
export function reached(mode: Mode, current: StepName, step: StepName): boolean {
  const steps = STEPS[mode];
  return steps.includes(step) && steps.indexOf(step) <= steps.indexOf(current);
}

/**
 * How it seems to have gone, which the learner can change: a solve passed first time without
 * hints was good, one that took more was hard, and one given up on was forgotten. A recall is
 * the learner's to judge, against the approach, and a twist is the grader's.
 */
export function suggestedRating(session: Session): Rating | null {
  if (session.mode !== "solve") return null;
  if (!session.passed) return "again";
  return session.submissions <= 1 && session.hints === 0 ? "good" : "hard";
}

export function describeCase(ref: CaseRef): string {
  switch (ref.kind) {
    case "example":
      return `Example ${ref.index + 1}`;
    case "test":
      return `Hidden test ${ref.index + 1}`;
    case "random":
      return `A random input of size ${ref.size}`;
  }
}

/** How a run that went wrong went wrong. */
export function describeRun(run: Run): string {
  switch (run.ending.status) {
    case "timed_out":
      return "Took too long";
    case "cancelled":
      return "Stopped";
    case "exited":
      if (run.ending.code !== 0) return "Crashed";
      return printedTooMuch(run) === null ? "Wrong answer" : "Output cut off";
  }
}

/**
 * Why a run that finished couldn't be compared with what was expected, if it printed more than
 * is kept of a run's output.
 */
export function printedTooMuch(run: Run): string | null {
  if (run.cut_off === null || run.ending.status !== "exited" || run.ending.code !== 0) {
    return null;
  }
  return `It printed more than ${formatSize(run.cut_off)}, where output is cut off, so it couldn't be compared with the expected output.`;
}

/** A number of bytes as a person would say it, such as 64 KiB, as the server says them. */
export function formatSize(bytes: number): string {
  const kib = 1024;
  const mib = 1024 * kib;
  if (bytes >= mib) return `${(bytes / mib).toFixed(1)} MiB`;
  if (bytes >= kib) return `${Math.ceil(bytes / kib)} KiB`;
  return bytes === 1 ? "1 byte" : `${bytes} bytes`;
}
