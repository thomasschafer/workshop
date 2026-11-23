import { describe, expect, it } from "vitest";
import {
  applying,
  commentIsOn,
  commentPlace,
  describeCase,
  describeRun,
  fileState,
  fold,
  formatSize,
  lastCall,
  MOST_FOUND,
  newFileProblem,
  openAt,
  partOf,
  printedTooMuch,
  pythonLiteral,
  pythonValue,
  reached,
  sameReturn,
  sameSitting,
  search,
  showCalls,
  stepAfter,
  stepsFor,
  suggestedRating,
  testLabel,
  testOf,
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
    // Beside what was expected, a forgotten return shows as None, the first call that differs
    // is marked, and results beyond the calls are shown.
    expect(showCalls(buffer, input, 'null\nnull\n["x"]\n7\n', 'null\n"hi"\n["y"]\n')).toBe(
      'TextBuffer()\ninsert("hi", 2)\ntext() → None  ✗\nlines() → ["x"]\n(more than was called) 7',
    );
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
    // Words inside a string are the string's.
    expect(sameReturn('"True or None"', "'True or None'")).toBe(true);
    expect(sameReturn('["it\'s"]', '["it\'s"]')).toBe(true);
    expect(sameReturn("[1,2]", "(1, 2)")).toBe(true);
    expect(pythonLiteral("[1, 'a', {'k': None}]")).toEqual([1, "a", { k: null }]);
    expect(pythonLiteral("print(1)")).toBeUndefined();
    expect(pythonLiteral("[1, 2")).toBeUndefined();
  });

  it("know which parts' tests apply, and when two sessions are one sitting", () => {
    const part = (replaces: number[]) => ({ prompt: "", examples: [], hints: [], replaces });
    const parts = [part([]), part([]), part([0])];
    expect(applying(parts, 0)).toEqual([0]);
    expect(applying(parts, 1)).toEqual([0, 1]);
    expect(applying(parts, 2)).toEqual([1, 2]);
    const here = session({ started_at: 5, part: 1, plans: ["a"] });
    expect(sameSitting(here, { ...here, plan: "other" })).toBe(true);
    expect(sameSitting(here, { ...here, part: 2, plans: ["a", "b"] })).toBe(false);
    expect(sameSitting(here, { ...here, started_at: 6 })).toBe(false);
  });
});

describe("work in a codebase", () => {
  it("starts solving a project at its plan", () => {
    expect(stepsFor("solve", true)).toEqual(["plan", "code", "test", "review"]);
    expect(stepsFor("recall", true)).toEqual(["plan", "review"]);
    expect(stepAfter("solve", "plan", true)).toBe("code");
    expect(reached("solve", "code", "understand", true)).toBe(false);
    expect(reached("solve", "code", "plan", true)).toBe(true);
    expect(stepsFor("solve")[0]).toBe("understand");
  });

  it("names a project's tests from their cases", () => {
    expect(testOf("test_loans.py::test_lends_for_three_weeks\n")).toEqual({
      file: "test_loans.py",
      name: "test_lends_for_three_weeks",
    });
    expect(testOf("1 2 3")).toBeNull();
    expect(testOf("a::b::c")).toBeNull();
    expect(testLabel("test_a_day_missed_ends_the_streak")).toBe("a day missed ends the streak");
  });

  it("searches a project's files, ignoring case", () => {
    const files = [
      {
        path: "words.py",
        text: "import re\n\ndef split_words(text):\n    return RE.split(text)\n",
      },
      { path: "stats.py", text: "from words import split_words\n" },
    ];
    expect(search(files, "re.split")).toEqual([
      { path: "words.py", line: 4, text: "return RE.split(text)" },
    ]);
    expect(search(files, "split_words").map((f) => `${f.path}:${f.line}`)).toEqual([
      "words.py:3",
      "stats.py:1",
    ]);
    expect(search(files, "  ")).toEqual([]);
    const many = [{ path: "x.py", text: "x\n".repeat(MOST_FOUND + 10) }];
    expect(search(many, "x")).toHaveLength(MOST_FOUND);
  });

  it("checks a new file's name as the server does", () => {
    expect(newFileProblem("clock.py", ["tracker.py"])).toBeNull();
    expect(newFileProblem("tracker.py", ["tracker.py"])).toMatch(/already/);
    expect(newFileProblem("test_clock.py", [])).toMatch(/Test files/);
    expect(newFileProblem("lib/clock.py", [])).toMatch(/letters/);
    expect(newFileProblem(".clock.py", [])).toMatch(/letters/);
    expect(newFileProblem("notes.txt", [])).toMatch(/\.py/);
  });

  it("marks a project's files the learner has changed or added", () => {
    const file = (original: string | null) => ({
      path: "a.py",
      code: { text: "x = 1\n", version: "v", path: "/p/a.py" },
      original,
      read_only: false,
      uri: "file:///p/a.py",
    });
    expect(fileState(file("x = 1\n"), "x = 1\n")).toBeNull();
    expect(fileState(file("x = 1\n"), "x = 2\n")).toBe("changed");
    expect(fileState(file(null), "")).toBe("added");
    const project = {
      task: "fix" as const,
      files: [{ ...file("t"), path: "test_a.py", read_only: true }, file("x")],
      editor_mode: "python",
      lsp: null,
      empty_version: "e",
    };
    // The file open last, or else the first that isn't a test.
    expect(openAt(project, "test_a.py")).toBe("test_a.py");
    expect(openAt(project, "gone.py")).toBe("a.py");
    expect(openAt(project, null)).toBe("a.py");
  });

  it("folds long stretches of a change kept the same", () => {
    const kept = (n: number) => ({ kind: "kept" as const, old: n, new: n, text: `${n}` });
    const lines = [
      ...[1, 2, 3, 4, 5].map(kept),
      { kind: "added" as const, old: null, new: 6, text: "new" },
      ...[6, 7, 8, 9, 10, 11].map(kept),
    ];
    const shown = fold(lines, 2);
    expect(shown[0]).toEqual({ folded: 3, from: 0 });
    expect(shown.slice(1, 6).map((s) => ("line" in s ? s.line.text : null))).toEqual([
      "4",
      "5",
      "new",
      "6",
      "7",
    ]);
    expect(shown[6]).toEqual({ folded: 4, from: 8 });
    expect(fold(lines, 10).every((s) => "line" in s)).toBe(true);
  });

  it("places a review's comments", () => {
    const comment = { id: "c", file: "loans.py", line: 47, old: false, text: "Off by one" };
    expect(commentPlace(comment)).toBe("loans.py, line 47");
    expect(commentPlace({ ...comment, old: true })).toBe("loans.py, old line 47");
    expect(commentPlace({ ...comment, line: null })).toBe("loans.py");
    expect(commentPlace({ ...comment, file: null, line: null })).toBe("The whole change");
    const added = { kind: "added" as const, old: null, new: 47, text: "x" };
    const removed = { kind: "removed" as const, old: 47, new: null, text: "y" };
    expect(commentIsOn(comment, "loans.py", added)).toBe(true);
    expect(commentIsOn(comment, "loans.py", removed)).toBe(false);
    expect(commentIsOn({ ...comment, old: true }, "loans.py", removed)).toBe(true);
    expect(commentIsOn(comment, "catalogue.py", added)).toBe(false);
  });
});
