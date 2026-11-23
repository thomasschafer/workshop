import type { Rating } from "../learning/types";
import type {
  Api,
  CaseRef,
  Comment,
  DiffLine,
  Mode,
  OpenedPart,
  Run,
  Session,
  StepName,
  Task,
  TwistKind,
} from "./types";

const STEPS: Record<Mode, StepName[]> = {
  solve: ["understand", "plan", "code", "test", "review"],
  recall: ["plan", "review"],
  twist: ["twist"],
};

/** Solving a project starts with planning, as there's code to read rather than an example. */
const PROJECT_SOLVE: StepName[] = ["plan", "code", "test", "review"];

/** The steps of going through a problem this way, as `Mode::steps_for` says. */
export function stepsFor(mode: Mode, project = false): StepName[] {
  return project && mode === "solve" ? PROJECT_SOLVE : STEPS[mode];
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
export function stepAfter(mode: Mode, step: StepName, project = false): StepName | null {
  const steps = stepsFor(mode, project);
  return steps[steps.indexOf(step) + 1] ?? null;
}

/** Whether a step can be gone back to from where the learner is: any that's been done. */
export function reached(mode: Mode, current: StepName, step: StepName, project = false): boolean {
  const steps = stepsFor(mode, project);
  return steps.includes(step) && steps.indexOf(step) <= steps.indexOf(current);
}

export const TASKS: Record<Task, string> = {
  fix: "Fix a bug",
  review: "Review a change",
  refactor: "Refactor and extend",
};

/** Which test a case in a project is, from its input, such as `test_loans.py::test_due`. */
export function testOf(input: string): { file: string; name: string } | null {
  const [file, name, ...rest] = input.trim().split("::");
  return file && name && rest.length === 0 ? { file, name } : null;
}

/** A test's name as a person reads it: `test_a_day_missed` is "a day missed". */
export function testLabel(name: string): string {
  return name.replace(/^test_/, "").replaceAll("_", " ");
}

/** Where a line was found by searching a project's files. */
export interface Found {
  path: string;
  /** Counting from 1. */
  line: number;
  text: string;
}

/** The most lines a search finds, so a common word doesn't fill a phone's screen. */
export const MOST_FOUND = 50;

/** The lines of these files that have `query` in them, ignoring case, in order. */
export function search(files: readonly { path: string; text: string }[], query: string): Found[] {
  const wanted = query.trim().toLowerCase();
  if (wanted === "") return [];
  const found: Found[] = [];
  for (const file of files) {
    const lines = file.text.split("\n");
    for (const [at, text] of lines.entries()) {
      if (text.toLowerCase().includes(wanted)) {
        found.push({ path: file.path, line: at + 1, text: text.trim() });
        if (found.length === MOST_FOUND) return found;
      }
    }
  }
  return found;
}

/**
 * Why a new file can't have this name in a project, or null if it can: as the server says,
 * letters, digits, `_`, `-` and `.`, a `.py` file that isn't one of tests, and not one there
 * already.
 */
export function newFileProblem(name: string, taken: readonly string[]): string | null {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name) || name.startsWith(".")) {
    return "Use letters, digits, _, - and . in the name.";
  }
  if (!name.endsWith(".py")) return "Name it as a Python file, ending .py.";
  if (/^test_.*\.py$/.test(name)) return "Test files are the problem's own; name it otherwise.";
  if (taken.includes(name)) return `There's a ${name} already.`;
  return null;
}

/** Runs of a change's lines, with long stretches kept the same folded away. */
export type Shown = { line: DiffLine } | { folded: number; from: number };

/**
 * A change's lines as a phone shows them: every line added or removed, with `context` lines kept
 * the same around each, and the rest folded into a count, from `from`, its index in `lines`.
 */
export function fold(lines: readonly DiffLine[], context: number): Shown[] {
  const near = lines.map(() => false);
  lines.forEach((line, at) => {
    if (line.kind === "kept") return;
    for (let n = Math.max(0, at - context); n <= Math.min(lines.length - 1, at + context); n++) {
      near[n] = true;
    }
  });
  const shown: Shown[] = [];
  let at = 0;
  while (at < lines.length) {
    if (near[at]) {
      shown.push({ line: lines[at] as DiffLine });
      at++;
      continue;
    }
    const from = at;
    while (at < lines.length && !near[at]) at++;
    shown.push({ folded: at - from, from });
  }
  return shown;
}

/** Where a review comment is about, as it's shown, such as "loans.py, line 47". */
export function commentPlace(comment: Pick<Comment, "file" | "line" | "old">): string {
  if (comment.file === null) return "The whole change";
  if (comment.line === null) return comment.file;
  return comment.old
    ? `${comment.file}, old line ${comment.line}`
    : `${comment.file}, line ${comment.line}`;
}

/** Whether a comment is about this line of a file: by its new number, or a removed line's old. */
export function commentIsOn(comment: Comment, path: string, line: DiffLine): boolean {
  if (comment.file !== path || comment.line === null) return false;
  return comment.old
    ? line.kind === "removed" && line.old === comment.line
    : line.kind !== "removed" && line.new === comment.line;
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

/**
 * Whether two sessions are the same sitting at the same place in it: started together, in the
 * same mode and on the same part. Only then can what's on the device be saved over the other.
 */
export function sameSitting(a: Session, b: Session): boolean {
  return a.started_at === b.started_at && a.mode === b.mode && a.part === b.part;
}

/**
 * The parts, counting from 0, whose examples and tests apply once the learner is on `part`: it,
 * and every earlier part that no part up to it replaces, as `Coding::applying` says.
 */
export function applying(parts: readonly OpenedPart[], part: number): number[] {
  return parts
    .slice(0, part + 1)
    .map((_, earlier) => earlier)
    .filter(
      (earlier) =>
        !parts.slice(earlier + 1, part + 1).some((later) => later.replaces.includes(earlier)),
    );
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

/** Whether two values are the same, as the server compares results: as values. */
function sameValue(a: unknown, b: unknown): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * The calls a case makes in API mode, shown as Python, a line each, with what each returned
 * beside it, from `output`, unless it's null. A call that returned nothing has nothing beside
 * it, and the first a run stopped at, with no result, says so. Given what was `expected`, as
 * for what a solution returned, a call returning nothing where something was expected says
 * `→ None`, the first call whose result differs is marked, and results beyond the calls are
 * shown too.
 */
export function showCalls(
  api: Api,
  input: string,
  output: string | null,
  expected?: string,
): string {
  const results = output === null ? null : values(output);
  const wanted = expected === undefined ? null : values(expected);
  let next = 0;
  let stopped = false;
  let marked = false;
  const lines = values(input).map(({ value, json }) => {
    if (!json || !Array.isArray(value) || typeof value[0] !== "string") return String(value);
    const [name, ...args] = value as [string, ...unknown[]];
    const call = `${name}(${args.map(pythonValue).join(", ")})`;
    if (name === api.class || results === null) return call;
    const at = next++;
    const result = results[at];
    if (result === undefined) {
      if (stopped) return call;
      stopped = true;
      marked = true;
      return `${call}  ✗ stopped here`;
    }
    const want = wanted?.[at];
    const differs = want !== undefined && !(result.json && sameValue(result.value, want.value));
    const mark = differs && !marked ? "  ✗" : "";
    if (differs) marked = true;
    if (!result.json) return `${call} → ${String(result.value)}${mark}`;
    const shown = result.value !== null || (want !== undefined && want.value !== null);
    return `${shown ? `${call} → ${pythonValue(result.value)}` : call}${mark}`;
  });
  if (results !== null) {
    for (const extra of results.slice(next)) {
      lines.push(
        `(more than was called) ${extra.json ? pythonValue(extra.value) : String(extra.value)}`,
      );
    }
  }
  return lines.join("\n");
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
 * A Python literal, as a learner types what a call returns: None, True and False, numbers,
 * strings in either quotes, and lists, tuples and dicts of them. Undefined for anything else.
 */
export function pythonLiteral(text: string): unknown {
  let at = 0;
  const fail = Symbol("not a literal");
  const space = () => {
    while (at < text.length && /\s/.test(text[at] ?? "")) at++;
  };
  const value = (): unknown => {
    space();
    const ch = text[at];
    if (ch === '"' || ch === "'") {
      let out = "";
      at++;
      while (at < text.length && text[at] !== ch) {
        if (text[at] === "\\") {
          at++;
          const escaped = text[at] ?? "";
          out += ({ n: "\n", t: "\t", r: "\r" } as Record<string, string>)[escaped] ?? escaped;
        } else {
          out += text[at];
        }
        at++;
      }
      if (text[at] !== ch) throw fail;
      at++;
      return out;
    }
    if (ch === "[" || ch === "(") {
      const close = ch === "[" ? "]" : ")";
      at++;
      const items: unknown[] = [];
      space();
      while (text[at] !== close) {
        items.push(value());
        space();
        if (text[at] === ",") at++;
        else if (text[at] !== close) throw fail;
        space();
      }
      at++;
      return items;
    }
    if (ch === "{") {
      at++;
      const entries: [string, unknown][] = [];
      space();
      while (text[at] !== "}") {
        const key = value();
        space();
        if (text[at] !== ":") throw fail;
        at++;
        entries.push([String(key), value()]);
        space();
        if (text[at] === ",") at++;
        else if (text[at] !== "}") throw fail;
        space();
      }
      at++;
      return Object.fromEntries(entries);
    }
    const word = /^(None|True|False|null|true|false|-?\d+(\.\d+)?([eE][-+]?\d+)?)/.exec(
      text.slice(at),
    )?.[0];
    if (word === undefined) throw fail;
    at += word.length;
    if (word === "None" || word === "null") return null;
    if (word === "True" || word === "true") return true;
    if (word === "False" || word === "false") return false;
    return Number(word);
  };
  try {
    const parsed = value();
    space();
    return at === text.length ? parsed : undefined;
  } catch (e) {
    if (e === fail) return undefined;
    throw e;
  }
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
  if (typeof value === "string" && text === value) return true;
  const parsed = pythonLiteral(text);
  return parsed !== undefined && sameValue(parsed, value);
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
