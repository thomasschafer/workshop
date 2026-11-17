import { describe, expect, it } from "vitest";
import {
  describeCase,
  describeRun,
  formatSize,
  printedTooMuch,
  reached,
  stepAfter,
  stepsFor,
  suggestedRating,
} from "./steps";
import type { Session } from "./types";

const session = (changes: Partial<Session>): Session => ({
  mode: "solve",
  step: "review",
  language: "python",
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
  });

  it("say what a case and a run were", () => {
    expect(describeCase({ kind: "example", index: 0 })).toBe("Example 1");
    expect(describeCase({ kind: "random", seed: 4, size: 2 })).toBe("A random input of size 2");
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
});
