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
      return run.ending.code === 0 ? "Wrong answer" : "Crashed";
  }
}
