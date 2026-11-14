import { describe, expect, it } from "vitest";
import cases from "../../../crates/pack/tests/grading.json";
import { displayNumber, grade, parseNumber } from "./grading";

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
