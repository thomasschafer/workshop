import { describe, expect, it } from "vitest";
import { mergeSegments } from "./voice";

describe("mergeSegments", () => {
  it("joins consecutive pieces", () => {
    expect(mergeSegments(["map read", " dot lines"])).toBe("map read dot lines");
  });

  it("collapses Android's growing copies of the same sentence", () => {
    const segments = [
      "can",
      "can you",
      "can you replace",
      "can you replace the brackets",
      "can you replace the brackets online six and seven with dollars after print",
    ];
    expect(mergeSegments(segments)).toBe(
      "can you replace the brackets online six and seven with dollars after print",
    );
  });

  it("uses Android's latest guess when it revises earlier words", () => {
    // From a real session: each piece restates the sentence, sometimes shorter than before.
    const segments = [
      "can you replace the dollars online six and seven with open",
      "can you replace the dollars online six and seven with",
      "can you replace the dollars online six and seven with open",
      "can you replace the dollars online six and seven with open (and",
      "can you replace the dollars online six and seven with open bracket and",
      "can you replace the dollars online six and seven with open bracket and add",
      "can you replace the dollars online six and seven with open (and add a",
      "can you replace the dollars online six and seven with (and add a",
      "can you replace the dollars online six and seven with open (and add a closed)",
      "can you replace the dollars online six and seven with open (and add a closed) at the end of both Lines",
    ];
    expect(mergeSegments(segments)).toBe(
      "can you replace the dollars online six and seven with open (and add a closed) at the end of both Lines",
    );
  });

  it("joins pieces that happen to start with the same word", () => {
    expect(mergeSegments(["map read", "map show"])).toBe("map read map show");
  });

  it("handles a repeated final copy and casing changes", () => {
    expect(mergeSegments(["Fold are", "fold are plus zero", "fold are plus zero"])).toBe(
      "fold are plus zero",
    );
  });

  it("keeps a new sentence after a growing one", () => {
    expect(mergeSegments(["before", "before that sum", "dot"])).toBe("before that sum dot");
  });

  it("ignores empty results", () => {
    expect(mergeSegments(["", "  ", "undo"])).toBe("undo");
  });
});
