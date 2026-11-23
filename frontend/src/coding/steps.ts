import type { Rating } from "../learning/types";
import type { Api, CaseRef, Mode, Run, Session, StepName, TwistKind } from "./types";

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
  // A problem in parts is submitted at least once a part.
  return session.submissions <= session.part + 1 && session.hints === 0 ? "good" : "hard";
}

export function describeCase(ref: CaseRef): string {
  const part = ref.part === undefined ? null : ref.part + 1;
  switch (ref.kind) {
    case "example":
      return part === null ? `Example ${ref.index + 1}` : `Part ${part}'s example ${ref.index + 1}`;
    case "test":
      return part === null
        ? `Hidden test ${ref.index + 1}`
        : `Part ${part}'s hidden test ${ref.index + 1}`;
    case "random":
      return part === null
        ? `A random input of size ${ref.size}`
        : `A random input of size ${ref.size}, for part ${part}`;
  }
}

/**
 * How many of a problem's parts the learner can see, as the server says: those they've
 * reached while solving it, and every part once it's reviewed or in a review of it.
 */
export function revealed(session: Session, count: number): number {
  return session.mode === "solve" && session.step !== "review" ? session.part + 1 : count;
}

/** Where the learner is in a problem in parts, such as "Part 2 of 3". */
export function partOf(part: number, count: number): string {
  return `Part ${part + 1} of ${count}`;
}

/** A JSON value as Python writes it, as calls and what they return are shown in API mode. */
export function pythonValue(value: unknown): string {
  if (value === null) return "None";
  if (value === true) return "True";
  if (value === false) return "False";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(pythonValue).join(", ")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}: ${pythonValue(item)}`).join(", ")}}`;
  }
  throw new Error(`${String(value)} isn't a value calls make or return`);
}

/** Each line of some JSON lines as a value, or as the line itself where it isn't JSON. */
function values(lines: string): { value: unknown; json: boolean }[] {
  return lines
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return { value: JSON.parse(line) as unknown, json: true };
      } catch {
        return { value: line, json: false };
      }
    });
}

/**
 * The calls a case makes in API mode, shown as Python, a line each, with what each returned
 * beside it, from `output`, unless it's null. A call that returned nothing has nothing beside
 * it, and the first a run stopped at, with no result, says so.
 */
export function showCalls(api: Api, input: string, output: string | null): string {
  const results = output === null ? null : values(output);
  let next = 0;
  let stopped = false;
  return values(input)
    .map(({ value, json }) => {
      if (!json || !Array.isArray(value) || typeof value[0] !== "string") return String(value);
      const [name, ...args] = value as [string, ...unknown[]];
      const call = `${name}(${args.map(pythonValue).join(", ")})`;
      if (name === api.class || results === null) return call;
      const result = results[next++];
      if (result === undefined) {
        if (stopped) return call;
        stopped = true;
        return `${call}  ✗ stopped here`;
      }
      if (!result.json) return `${call} → ${String(result.value)}`;
      return result.value === null ? call : `${call} → ${pythonValue(result.value)}`;
    })
    .join("\n");
}

/** The last call a case makes in API mode, as Python, and what it returns, as JSON. */
export function lastCall(
  api: Api,
  input: string,
  output: string,
): { call: string; returns: string } | null {
  const calls = values(input).filter(({ value }) => Array.isArray(value) && value[0] !== api.class);
  const returned = output.split("\n").filter((line) => line.trim() !== "");
  const last = calls[calls.length - 1];
  const returns = returned[returned.length - 1];
  if (last === undefined || returns === undefined || calls.length !== returned.length) return null;
  const [name, ...args] = last.value as [string, ...unknown[]];
  return { call: `${name}(${args.map(pythonValue).join(", ")})`, returns };
}

/** A value with its object's keys in order, so two can be compared by their JSON. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, canonical(item)]),
    );
  }
  return value;
}

/**
 * Whether what the learner typed is what a call returns, given as JSON: written as Python or
 * as JSON, and a string with or without its quotes.
 */
export function sameReturn(expected: string, typed: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(expected);
  } catch {
    return false;
  }
  const text = typed.trim();
  if (typeof value === "string" && (text === value || text === `'${value}'`)) return true;
  const asJson = text
    .replace(/\bNone\b/g, "null")
    .replace(/\bTrue\b/g, "true")
    .replace(/\bFalse\b/g, "false")
    .replace(/'([^'"\\]*)'/g, '"$1"');
  try {
    return JSON.stringify(canonical(JSON.parse(asJson))) === JSON.stringify(canonical(value));
  } catch {
    return false;
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
