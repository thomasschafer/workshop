import { describe, expect, it } from "vitest";
import type { DayMeta, Problem } from "./api";
import {
  answerCode,
  EMPTY_META,
  needsSample,
  sameValues,
  sampleInput,
  setAnswer,
  setSampleText,
  toggleAnswer,
  toggleSample,
  withFoundSample,
  withSuggestions,
} from "./samples";

const problem = (overrides: Partial<Problem> = {}): Problem => ({
  title: "Day 1",
  parts_html: ["<p>one</p>", "<p>two</p>"],
  text: "",
  answers: ["10"],
  stars: 1,
  final_star: null,
  suggested_sample_answers: ["3", "7"],
  suggested_sample_blocks: [0, null],
  blocks: ["1\n2\n", "illustration", "5\n6\n"],
  ...overrides,
});

describe("withSuggestions", () => {
  it("fills empty slots, with part 2 reusing part 1's sample", () => {
    const meta = withSuggestions(EMPTY_META, problem());
    expect(meta.sample_blocks).toEqual([0, null]);
    expect(meta.sample_answers).toEqual(["3", "7"]);
    expect(sampleInput(meta, 0)).toBe("1\n2\n");
    expect(sampleInput(meta, 1)).toBe("1\n2\n");
  });

  it("leaves part 2 without a sample when it has no answer to check part 1's against", () => {
    const meta = withSuggestions(EMPTY_META, problem({ suggested_sample_answers: ["3", null] }));
    expect(sampleInput(meta, 1)).toBeNull();
    expect(sampleInput(setAnswer(meta, 1, "7"), 1)).toBe("1\n2\n");
  });

  it("uses part 2's own sample when it has one", () => {
    const meta = withSuggestions(EMPTY_META, problem({ suggested_sample_blocks: [0, 2] }));
    expect(sampleInput(meta, 1)).toBe("5\n6\n");
  });

  it("never overrides the user's choices", () => {
    const chosen = toggleAnswer(toggleSample(EMPTY_META, problem(), 0, 2), 0, "99");
    const meta = withSuggestions(chosen, problem());
    expect(meta.sample_blocks[0]).toBe(2);
    expect(meta.sample_answers[0]).toBe("99");
  });

  it("returns the same object when nothing changes", () => {
    const meta = withSuggestions(EMPTY_META, problem());
    expect(withSuggestions(meta, problem())).toBe(meta);
  });
});

describe("toggles", () => {
  it("toggle samples and answers on and off", () => {
    const on = toggleSample(EMPTY_META, problem(), 1, 2);
    expect(sampleInput(on, 1)).toBe("5\n6\n");
    const off = toggleSample(on, problem(), 1, 2);
    expect(off.sample_blocks[1]).toBeNull();
    expect(toggleAnswer(toggleAnswer(EMPTY_META, 0, "4"), 0, "4").sample_answers[0]).toBeNull();
  });
});

describe("manual samples", () => {
  it("sets typed sample input and answers, clearing the chosen block", () => {
    const withBlock = toggleSample(EMPTY_META, problem(), 0, 0);
    const typed = setSampleText(withBlock, 0, "+1\n-2\n");
    expect(typed.sample_blocks[0]).toBeNull();
    expect(sampleInput(typed, 0)).toBe("+1\n-2\n");
    expect(setSampleText(typed, 0, "  ").sample_inputs[0]).toBeNull();
    expect(setAnswer(EMPTY_META, 1, " 7 ").sample_answers[1]).toBe("7");
    expect(setAnswer(EMPTY_META, 1, "").sample_answers[1]).toBeNull();
  });
});

describe("found samples", () => {
  const found = { input: "+2\n-5\n+4\n", answer: "1" };
  const none = problem({
    suggested_sample_answers: [null, null],
    suggested_sample_blocks: [null, null],
  });

  it("is looked for while a part lacks an input or an answer", () => {
    expect(needsSample(EMPTY_META, none, 0, false)).toBe(true);
    const both = { ...EMPTY_META, sample_inputs: ["1\n", null], sample_answers: ["3", "4"] };
    expect(needsSample(both as DayMeta, none, 0, false)).toBe(false);
    // Part 2 uses part 1's input, so it only needs its answer.
    expect(needsSample(both as DayMeta, none, 1, false)).toBe(false);
    const noAnswer = { ...both, sample_answers: ["3", null] };
    expect(needsSample(noAnswer as DayMeta, none, 1, false)).toBe(true);
  });

  it("is looked for when only suggestions that can't be relied on are there", () => {
    const suggested = withSuggestions(EMPTY_META, problem());
    expect(needsSample(suggested, problem(), 0, false)).toBe(false);
    expect(needsSample(suggested, problem(), 0, true)).toBe(true);
    const chosen = setAnswer(suggested, 0, "4");
    expect(needsSample(chosen, problem(), 0, true)).toBe(false);
  });

  it("fills in a part's input and answer together", () => {
    const meta = withFoundSample(EMPTY_META, none, 0, found, false);
    expect(meta.sample_inputs).toEqual([found.input, null]);
    expect(meta.sample_answers).toEqual(["1", null]);
  });

  it("only adds an answer to the input it belongs to", () => {
    const chosen: DayMeta = { ...EMPTY_META, sample_inputs: ["9\n9\n", null] };
    expect(withFoundSample(chosen, none, 0, found, true)).toBe(chosen);
    const same: DayMeta = { ...EMPTY_META, sample_inputs: ["+2\n-5\n+4", null] };
    expect(withFoundSample(same, none, 0, found, false).sample_answers).toEqual(["1", null]);
    const answered: DayMeta = { ...EMPTY_META, sample_answers: ["7", null] };
    expect(withFoundSample(answered, none, 0, found, true)).toBe(answered);
  });

  it("replaces what was only suggested, choosing a code block when the example is one", () => {
    const suggested = withSuggestions(EMPTY_META, problem());
    const meta = withFoundSample(suggested, problem(), 0, { input: "5\n6\n", answer: "11" }, true);
    expect(meta.sample_blocks).toEqual([2, null]);
    expect(meta.sample_inputs).toEqual(["5\n6\n", null]);
    expect(meta.sample_answers).toEqual(["11", "7"]);
    // Without leave to replace them, the suggestions stay.
    expect(withFoundSample(suggested, problem(), 0, found, false)).toBe(suggested);
  });

  it("keeps part 2 on part 1's input when the example is the same", () => {
    const partOne: DayMeta = {
      ...EMPTY_META,
      sample_inputs: [found.input, null],
      sample_answers: ["1", null],
    };
    const meta = withFoundSample(partOne, none, 1, { input: found.input, answer: "-3" }, false);
    expect(meta.sample_inputs).toEqual([found.input, null]);
    expect(meta.sample_answers).toEqual(["1", "-3"]);
    const own = withFoundSample(partOne, none, 1, { input: "+1\n-1\n", answer: "0" }, false);
    expect(own.sample_inputs).toEqual([found.input, "+1\n-1\n"]);
  });
});

describe("marking the sample in the puzzle", () => {
  it("matches an inline example to its sample written one value per line", () => {
    expect(sameValues("+1, -2, +3, +1", "+1\n-2\n+3\n+1\n")).toBe(true);
    expect(sameValues("+1, -2", "+1\n-2\n+3\n")).toBe(false);
    expect(sameValues("", "")).toBe(false);
  });

  const code = (text: string, afterSample: boolean, emphasised = false) => ({
    text,
    afterSample,
    emphasised,
  });

  it("marks the answer that ends the worked example, not every copy of it", () => {
    const codes = [
      code("3", false), // "decreases by 3", before the example
      code("+1, -2, +3, +1", false),
      code("2", true),
      code("3", true), // the walkthrough's result
      code("3", true), // "In this example, the result is 3"
      code("+1, +1, +1", true),
      code("3", true),
    ];
    expect(answerCode(codes, "3")).toBe(3);
  });

  it("marks the emphasised answer when the puzzle emphasises it", () => {
    expect(answerCode([code("7", true), code("7", true, true), code("7", true)], "7")).toBe(1);
  });

  it("marks the last copy when the sample isn't in this part", () => {
    expect(answerCode([code("2", false), code("2", false), code("0", false)], "2")).toBe(1);
    expect(answerCode([code("4", false)], "2")).toBeNull();
  });
});
