import { describe, expect, it } from "vitest";
import {
  formatCountdown,
  formatStarTime,
  isUnlocked,
  latestYear,
  nextUnlock,
  todaysPuzzle,
  unlockTime,
} from "./calendar";

const at = (iso: string) => Date.parse(iso);

describe("the calendar", () => {
  it("unlocks puzzles at midnight US Eastern", () => {
    expect(unlockTime(2026, 1)).toBe(at("2026-12-01T05:00:00Z"));
    expect(isUnlocked(2026, 3, at("2026-12-03T04:59:59Z"))).toBe(false);
    expect(isUnlocked(2026, 3, at("2026-12-03T05:00:00Z"))).toBe(true);
  });

  it("moves to a new year once its first puzzle unlocks, wherever you are", () => {
    // Already December 1st in London, but not yet in New York.
    expect(latestYear(at("2026-12-01T04:00:00Z"))).toBe(2025);
    expect(latestYear(at("2026-12-01T05:00:00Z"))).toBe(2026);
    expect(latestYear(at("2027-03-01T00:00:00Z"))).toBe(2026);
  });

  it("knows today's puzzle while the event runs", () => {
    expect(todaysPuzzle(at("2026-12-01T05:00:00Z"))).toEqual({ year: 2026, day: 1 });
    expect(todaysPuzzle(at("2026-12-04T04:59:00Z"))).toEqual({ year: 2026, day: 3 });
    expect(todaysPuzzle(at("2026-12-12T23:00:00Z"))).toEqual({ year: 2026, day: 12 });
    // Twelve days from 2025, so the 13th has no puzzle.
    expect(todaysPuzzle(at("2026-12-13T06:00:00Z"))).toBeNull();
    expect(todaysPuzzle(at("2026-11-30T12:00:00Z"))).toBeNull();
  });

  it("counts down to the next puzzle", () => {
    expect(nextUnlock(at("2026-12-03T06:00:00Z"))).toEqual({
      puzzle: { year: 2026, day: 4 },
      at: at("2026-12-04T05:00:00Z"),
    });
    expect(nextUnlock(at("2026-11-20T00:00:00Z"))?.puzzle).toEqual({ year: 2026, day: 1 });
    // The last day: nothing more to count down to, nor before November.
    expect(nextUnlock(at("2026-12-12T06:00:00Z"))).toBeNull();
    expect(nextUnlock(at("2026-10-15T00:00:00Z"))).toBeNull();
  });

  it("formats countdowns and star times briefly", () => {
    expect(formatCountdown(3 * 86_400_000 + 4 * 3_600_000)).toBe("3d 4h");
    expect(formatCountdown(2 * 3_600_000 + 14 * 60_000)).toBe("2h 14m");
    expect(formatCountdown(4 * 60_000 + 5_000)).toBe("4m 05s");
    expect(formatCountdown(-5)).toBe("0m 00s");
    expect(formatStarTime("01:03:06")).toBe("1:03:06");
    expect(formatStarTime("00:50:09")).toBe("50:09");
    expect(formatStarTime("00:05:09")).toBe("5:09");
    expect(formatStarTime(">24h")).toBe(">24h");
  });
});
