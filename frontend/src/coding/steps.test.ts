import { describe, expect, it } from "vitest";
import {
  describeCase,
  describeRun,
  formatSize,
  lastCall,
  partOf,
  printedTooMuch,
  pythonValue,
  reached,
  sameReturn,
  showCalls,
  stepAfter,
  stepsFor,
  suggestedRating,
} from "./steps";
import type { Session } from "./types";

const session = (changes: Partial<Session>): Session => ({
  mode: "solve",
  step: "review",
  language: "python",
  part: 0,
  plans: [],
  prediction: null,
  plan: "",
  passed: true,
  runs: 3,
  submissions: 1,
  hints: 0,
  no_twist: null,
  started_at: 0,
  updated_at: 0,
  ...changes,
});

describe("steps", () => {
  it("go in order, and a recall skips straight to the plan", () => {
    expect(stepsFor("solve")).toEqual(["understand", "plan", "code", "test", "review"]);
    expect(stepAfter("solve", "plan")).toBe("code");
    expect(stepAfter("solve", "review")).toBeNull();
    expect(stepAfter("recall", "plan")).toBe("review");
    expect(reached("solve", "code", "plan")).toBe(true);
    expect(reached("solve", "code", "test")).toBe(false);
    expect(reached("recall", "review", "code")).toBe(false);
    expect(stepsFor("twist")).toEqual(["twist"]);
    expect(stepAfter("twist", "twist")).toBeNull();
  });

  it("suggest how it went from how it was solved", () => {
    expect(suggestedRating(session({}))).toBe("good");
    expect(suggestedRating(session({ submissions: 3 }))).toBe("hard");
    expect(suggestedRating(session({ hints: 1 }))).toBe("hard");
    expect(suggestedRating(session({ passed: false }))).toBe("again");
    expect(suggestedRating(session({ mode: "recall" }))).toBeNull();
    expect(suggestedRating(session({ mode: "twist", step: "twist" }))).toBeNull();
    // A problem in parts is submitted once a part, at least.
    const third = { part: 2, plans: ["a", "b"] };
    expect(suggestedRating(session({ ...third, submissions: 3 }))).toBe("good");
    expect(suggestedRating(session({ ...third, submissions: 4 }))).toBe("hard");
    expect(suggestedRating(session({ ...third, passed: false }))).toBe("again");
  });

  it("say what a case and a run were", () => {
    expect(describeCase({ kind: "example", index: 0 })).toBe("Example 1");
    expect(describeCase({ kind: "random", seed: 4, size: 2 })).toBe("A random input of size 2");
    expect(describeCase({ kind: "example", part: 1, index: 0 })).toBe("Part 2's example 1");
    expect(describeCase({ kind: "test", part: 0, index: 2 })).toBe("Part 1's hidden test 3");
    expect(describeCase({ kind: "random", part: 2, seed: 4, size: 2 })).toBe(
      "A random input of size 2, for part 3",
    );
    expect(partOf(1, 3)).toBe("Part 2 of 3");
    const run = { stdout: "", stderr: "", cut_off: null, duration_ms: 1 };
    expect(describeRun({ ...run, ending: { status: "exited", code: 0 } })).toBe("Wrong answer");
    expect(describeRun({ ...run, ending: { status: "exited", code: 1 } })).toBe("Crashed");
    expect(describeRun({ ...run, ending: { status: "timed_out" } })).toBe("Took too long");
    expect(printedTooMuch({ ...run, ending: { status: "exited", code: 0 } })).toBeNull();
  });

  it("say when a run printed too much to be compared", () => {
    const run = { stdout: "", stderr: "", cut_off: 65536, duration_ms: 1 };
    const finished = { ...run, ending: { status: "exited", code: 0 } } as const;
    expect(describeRun(finished)).toBe("Output cut off");
    expect(printedTooMuch(finished)).toBe(
      "It printed more than 64 KiB, where output is cut off, so it couldn't be compared with the expected output.",
    );
    // Crashing or taking too long is what went wrong, however much it printed.
    expect(describeRun({ ...run, ending: { status: "exited", code: 1 } })).toBe("Crashed");
    expect(printedTooMuch({ ...run, ending: { status: "timed_out" } })).toBeNull();
  });

  it("say sizes as the server does", () => {
    expect(formatSize(65536)).toBe("64 KiB");
    expect(formatSize(1)).toBe("1 byte");
    expect(formatSize(900)).toBe("900 bytes");
    expect(formatSize(65 * 1024 + 1)).toBe("66 KiB");
    expect(formatSize(1_258_291)).toBe("1.2 MiB");
  });

  it("show calls in API mode as Python, with what each returned", () => {
    const buffer = { class: "TextBuffer" };
    const input = '["TextBuffer"]\n["insert","hi",2]\n["text"]\n["lines"]\n';
    expect(showCalls(buffer, input, null)).toBe('TextBuffer()\ninsert("hi", 2)\ntext()\nlines()');
    expect(showCalls(buffer, input, 'null\n"hi"\n[true, {"a": null}]\n')).toBe(
      'TextBuffer()\ninsert("hi", 2)\ntext() → "hi"\nlines() → [True, {"a": None}]',
    );
    // A run that stopped part-way says where.
    expect(showCalls(buffer, input, "null\n")).toBe(
      'TextBuffer()\ninsert("hi", 2)\ntext()  ✗ stopped here\nlines()',
    );
    expect(showCalls({ class: null }, '["area",2,3]\n', "6\n")).toBe("area(2, 3) → 6");
    expect(pythonValue(1.5)).toBe("1.5");
    expect(lastCall(buffer, input, 'null\n"hi"\n[]\n')).toEqual({
      call: "lines()",
      returns: "[]",
    });
    expect(lastCall(buffer, input, "null\n")).toBeNull();
  });

  it("take what a call returns typed as Python or JSON", () => {
    expect(sameReturn('"hi there"', "hi there")).toBe(true);
    expect(sameReturn('"hi"', '"hi"')).toBe(true);
    expect(sameReturn('"hi"', "'hi'")).toBe(true);
    expect(sameReturn("null", "None")).toBe(true);
    expect(sameReturn("true", "True")).toBe(true);
    expect(sameReturn('["ink","pens"]', "['ink', 'pens']")).toBe(true);
    expect(sameReturn('{"b":1,"a":2}', '{"a": 2, "b": 1}')).toBe(true);
    expect(sameReturn("3", " 3 ")).toBe(true);
    expect(sameReturn("3", "4")).toBe(false);
    expect(sameReturn('"3"', "three")).toBe(false);
    expect(sameReturn("false", "True")).toBe(false);
  });
});
