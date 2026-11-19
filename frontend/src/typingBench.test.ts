import { describe, expect, it } from "vitest";
import { score, TYPING_PHRASES } from "./typingBench";
import { editDistance } from "./wer";

describe("the edit distance", () => {
  it("counts the characters wrong, missing or added", () => {
    expect(editDistance([..."the dog"], [..."the dog"])).toBe(0);
    expect(editDistance([..."the dog"], [..."thw dog"])).toBe(1);
    expect(editDistance([..."the dog"], [..."te dog"])).toBe(1);
    expect(editDistance([..."the dog"], [..."thee dogs"])).toBe(2);
    expect(editDistance([], [..."ab"])).toBe(2);
  });
});

describe("a typing score", () => {
  it("is the share of every phrase's characters typed wrong, and the characters a minute", () => {
    const result = score([
      { kind: "prose", target: "abcde", typed: "abxde", ms: 2000 },
      { kind: "prose", target: "fghij", typed: "fghi", ms: 1000 },
    ]);
    expect(result?.errorRate).toBeCloseTo(2 / 10);
    expect(result?.characters).toBe(10);
    // Each phrase's clock starts at its first character: 4 and 3 characters after it, in 3s.
    expect(result?.perMinute).toBeCloseTo((7 / 3000) * 60_000);
  });

  it("is null for no phrases", () => {
    expect(score([])).toBeNull();
  });
});

describe("the phrases", () => {
  it("have prose of lower case letters alone, which any keyboard types alike", () => {
    for (const { text } of TYPING_PHRASES.filter((p) => p.kind === "prose")) {
      expect(text).toMatch(/^[a-z ]+$/);
    }
  });
});
