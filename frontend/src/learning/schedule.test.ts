import { describe, expect, it } from "vitest";
import cases from "../../../crates/learning/tests/fsrs.json";
import { DAY_MS, due, MIN_INTERVAL_MS, review } from "./schedule";
import type { ItemSchedule, Rating } from "./types";

describe("review", () => {
  it("schedules as the server does", () => {
    expect(cases.length).toBeGreaterThan(5);
    for (const { attempts, stability, difficulty, stability_fast, due_in_days } of cases) {
      let at = 1_700_000_000_000;
      let schedule: ItemSchedule | null = null;
      for (const [days, rating] of attempts as [number, Rating][]) {
        at += Math.trunc(days * DAY_MS);
        schedule = review(schedule, at, rating);
      }
      if (!schedule) throw new Error("a case with no attempts");
      const label = JSON.stringify(attempts);
      expect(schedule.stability, label).toBeCloseTo(stability, 3);
      expect(schedule.difficulty, label).toBeCloseTo(difficulty, 3);
      expect(schedule.stability_fast, label).toBeCloseTo(stability_fast, 3);
      expect((due(schedule, 0.9) - schedule.last_review) / DAY_MS, label).toBeCloseTo(
        due_in_days,
        2,
      );
    }
  });

  it("counts reviews and lapses", () => {
    const first = review(null, 0, "again");
    const second = review(first, DAY_MS, "good");
    const third = review(second, 5 * DAY_MS, "again");
    expect(third.reviews).toBe(3);
    expect(third.lapses).toBe(1);
    expect(due(first, 0.9)).toBe(MIN_INTERVAL_MS);
  });
});
