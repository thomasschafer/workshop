import { describe, expect, it } from "vitest";
import { isPractice, PRACTICE, puzzleLabel, puzzleTitle } from "./puzzle";

describe("puzzle names", () => {
  it("names real puzzles by year and day", () => {
    expect(puzzleLabel({ year: 2017, day: 4 })).toBe("2017 · day 4");
    expect(puzzleTitle({ year: 2017, day: 4 })).toBe("2017 day 4");
    expect(isPractice({ year: 2017, day: 4 })).toBe(false);
  });

  it("names the practice puzzle as such", () => {
    expect(isPractice(PRACTICE)).toBe(true);
    expect(puzzleLabel(PRACTICE)).toBe("Practice puzzle");
    expect(puzzleTitle(PRACTICE)).toBe("Workshop practice puzzle");
  });
});
