import { describe, expect, it } from "vitest";
import cases from "../../../crates/pack/tests/grading.json";
import {
  describeTolerance,
  displayApproximate,
  displayNumber,
  grade,
  parseNumber,
} from "./grading";

describe("grade", () => {
  it("grades as the server does", () => {
    expect(cases.length).toBeGreaterThan(10);
    for (const { expected, tolerance, response, correct } of cases) {
      expect(grade(expected, tolerance, response), `${response} against ${expected}`).toBe(correct);
    }
  });
});

describe("parseNumber", () => {
  it("reads numbers written in different ways", () => {
    expect(parseNumber("5/36")).toBe(5 / 36);
    expect(parseNumber(" 1,234 ")).toBe(1234);
    expect(parseNumber("12.5%")).toBe(0.125);
    expect(parseNumber(".5")).toBe(0.5);
    for (const bad of ["", "abc", "1/0", "1e5", "Infinity", "NaN", "1.2.3", ".", "1/2/3"]) {
      expect(parseNumber(bad), bad).toBeNull();
    }
  });
});

describe("displayNumber", () => {
  it("shows numbers without needless digits", () => {
    expect(displayNumber(42)).toBe("42");
    expect(displayNumber(0.125)).toBe("0.125");
    expect(displayNumber(1 / 3)).toBe("0.333333");
  });
});

describe("describeTolerance", () => {
  it("says how close an estimate must be, and nothing for an exact answer", () => {
    expect(describeTolerance({ absolute: 1e-9, relative: 0 })).toBeNull();
    expect(describeTolerance({ absolute: 1e-9, relative: 0.05 })).toBe("within 5%");
    expect(describeTolerance({ absolute: 1e-9, relative: 0.125 })).toBe("within 12.5%");
    expect(describeTolerance({ absolute: 1e-9, relative: 0, factor: 2 })).toBe(
      "within a factor of 2",
    );
    expect(describeTolerance({ absolute: 5, relative: 0 })).toBe("within 5 either way");
    expect(describeTolerance({ absolute: 1e-9, relative: 0.1, factor: 3 })).toBe(
      "within 10% or a factor of 3",
    );
  });
});

describe("displayApproximate", () => {
  it("rounds to four significant figures, grouped in thousands", () => {
    expect(displayApproximate(31_536_000)).toBe("31,540,000");
    expect(displayApproximate(1234.5678)).toBe("1,235");
    expect(displayApproximate(4.56789)).toBe("4.568");
    expect(displayApproximate(0.000123456)).toBe("0.0001235");
  });
});
