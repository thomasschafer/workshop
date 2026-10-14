import { describe, expect, it } from "vitest";
import { peakOf, resample } from "./audio";

describe("resample", () => {
  it("averages the samples each one stands for when going down", () => {
    const out = resample(new Float32Array([0.3, 0.6, 0.9, -0.3, -0.6, -0.9]), 48_000, 16_000);
    expect(Array.from(out).map((x) => Number(x.toFixed(3)))).toEqual([0.6, -0.6]);
  });

  it("keeps a recording's length in time", () => {
    expect(resample(new Float32Array(44_100), 44_100, 16_000)).toHaveLength(16_000);
    expect(resample(new Float32Array(8_000), 8_000, 16_000)).toHaveLength(16_000);
  });

  it("interpolates when going up", () => {
    const out = resample(new Float32Array([0, 1]), 8_000, 16_000);
    expect(Array.from(out)).toEqual([0, 0.5, 1, 1]);
  });

  it("leaves a recording at the same rate alone", () => {
    const samples = new Float32Array([0.1, 0.2]);
    expect(resample(samples, 16_000, 16_000)).toBe(samples);
  });
});

describe("peakOf", () => {
  it("finds the loudest sample, either way", () => {
    expect(peakOf(new Float32Array([0.1, -0.7, 0.4]))).toBeCloseTo(0.7);
    expect(peakOf(new Float32Array(0))).toBe(0);
  });
});
