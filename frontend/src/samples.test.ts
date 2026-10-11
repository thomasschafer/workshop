import { describe, expect, it } from "vitest";
import type { Problem } from "./api";
import { EMPTY_META, sampleInput, toggleAnswer, toggleSample, withSuggestions } from "./samples";

const problem = (overrides: Partial<Problem> = {}): Problem => ({
  title: "Day 1",
  parts_html: ["<p>one</p>", "<p>two</p>"],
  text: "",
  answers: ["10"],
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
