import { describe, expect, it } from "vitest";
import { NO_DIAGNOSTICS } from "./editor";
import { headline, type Problem, problemAt } from "./problems";
import { describeCounts } from "./views/status";

const problem = (
  from: number,
  to: number,
  severity: Problem["severity"],
  message = "m",
): Problem => ({
  from,
  to,
  line: 1,
  severity,
  message,
});

describe("the problem at the cursor", () => {
  it("is one the cursor is in, or at either end of", () => {
    const p = problem(4, 8, "error");
    expect(problemAt([p], 3)).toBeNull();
    expect(problemAt([p], 4)).toBe(p);
    expect(problemAt([p], 8)).toBe(p);
    expect(problemAt([p], 9)).toBeNull();
  });

  it("is the most serious there, and of those the one starting last", () => {
    const hint = problem(0, 20, "hint");
    const outer = problem(0, 20, "error", "outer");
    const inner = problem(5, 9, "error", "inner");
    const warning = problem(6, 7, "warning");
    expect(problemAt([hint, outer, inner, warning], 6)).toBe(inner);
    expect(problemAt([hint, outer, inner, warning], 12)).toBe(outer);
    expect(problemAt([hint, warning], 6)).toBe(warning);
  });
});

describe("a problem's headline", () => {
  it("is its first line", () => {
    expect(headline(problem(0, 1, "error", "  Not in scope: x  \n  Perhaps you meant y"))).toBe(
      "Not in scope: x",
    );
    expect(headline(problem(0, 1, "error", ""))).toBe("");
  });
});

describe("the count of problems", () => {
  it("names errors and warnings, and hints only when there's nothing worse", () => {
    const count = (errors: number, warnings: number, others: number) =>
      describeCounts({ ...NO_DIAGNOSTICS, errors, warnings, others });
    expect(count(0, 0, 0)).toBe("no errors");
    expect(count(1, 0, 0)).toBe("1 error");
    expect(count(2, 1, 5)).toBe("2 errors, 1 warning");
    expect(count(0, 3, 5)).toBe("3 warnings");
    expect(count(0, 0, 1)).toBe("1 hint");
  });
});
