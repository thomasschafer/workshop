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
