import { describe, expect, it } from "vitest";
import { puzzleToOpen } from "./notifications";

describe("puzzleToOpen", () => {
  it("reads the puzzle a notification's address opens", () => {
    expect(puzzleToOpen("?open=2026-4")).toEqual({ year: 2026, day: 4 });
    expect(puzzleToOpen("?open=2026-12&x=1")).toEqual({ year: 2026, day: 12 });
    expect(puzzleToOpen("?open=nonsense")).toBeNull();
    expect(puzzleToOpen("")).toBeNull();
  });
});
