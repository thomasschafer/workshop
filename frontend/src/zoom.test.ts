import { describe, expect, it } from "vitest";
import {
  clampCodeScale,
  codeScaleRange,
  pinchedCodeScale,
  roundCodeScale,
  stepCodeScale,
} from "./zoom";

const desk = codeScaleRange(false);
const iphone = codeScaleRange(true);

describe("codeScaleRange", () => {
  it("never makes the code smaller than usual on iOS", () => {
    expect(iphone.min).toBe(1);
    expect(desk.min).toBeLessThan(1);
  });
});

describe("clampCodeScale", () => {
  it("keeps the scale within the range", () => {
    expect(clampCodeScale(0.1, desk)).toBe(desk.min);
    expect(clampCodeScale(9, desk)).toBe(desk.max);
    expect(clampCodeScale(1.3, desk)).toBe(1.3);
    expect(clampCodeScale(0.8, iphone)).toBe(1);
  });

  it("fails loudly on a scale that isn't a number", () => {
    expect(() => clampCodeScale(Number.NaN, desk)).toThrow();
  });
});

describe("roundCodeScale", () => {
  it("rounds to the nearest percent", () => {
    expect(roundCodeScale(1.23456)).toBe(1.23);
  });
});

describe("stepCodeScale", () => {
  it("steps from one step to the next", () => {
    expect(stepCodeScale(1, 1, desk)).toBe(1.1);
    expect(stepCodeScale(1.1, 1, desk)).toBe(1.2);
    expect(stepCodeScale(1.2, -1, desk)).toBe(1.1);
    expect(stepCodeScale(1, -1, desk)).toBe(0.9);
  });

  it("goes to the step beside a scale between steps", () => {
    expect(stepCodeScale(1.23, 1, desk)).toBe(1.3);
    expect(stepCodeScale(1.23, -1, desk)).toBe(1.2);
  });

  it("stops at the ends of the range", () => {
    expect(stepCodeScale(desk.max, 1, desk)).toBe(desk.max);
    expect(stepCodeScale(desk.min, -1, desk)).toBe(desk.min);
    expect(stepCodeScale(1, -1, iphone)).toBe(1);
  });
});

describe("pinchedCodeScale", () => {
  it("scales with how far apart the fingers have moved", () => {
    expect(pinchedCodeScale(1, 100, 150, desk)).toBe(1.5);
    expect(pinchedCodeScale(1.2, 100, 50, desk)).toBe(desk.min);
    expect(pinchedCodeScale(1.5, 100, 400, desk)).toBe(desk.max);
  });

  it("leaves the scale as it was for fingers that start together", () => {
    expect(pinchedCodeScale(1.2, 0, 50, desk)).toBe(1.2);
  });
});
