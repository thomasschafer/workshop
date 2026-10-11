import { describe, expect, it } from "vitest";
import { markCursor, minimalChange, unmarkCursor } from "./diff";

describe("cursor markers", () => {
  it("round trips", () => {
    const marked = markCursor("solve = sum", 8);
    expect(marked).toBe("solve = ‸sum");
    expect(unmarkCursor(marked)).toEqual({ text: "solve = sum", cursor: 8 });
  });

  it("refuses documents that already contain the marker", () => {
    expect(() => markCursor("a‸b", 0)).toThrow();
  });

  it("requires exactly one marker", () => {
    expect(() => unmarkCursor("none")).toThrow();
    expect(() => unmarkCursor("‸two‸")).toThrow();
  });
});

describe("minimalChange", () => {
  it("finds an insertion", () => {
    expect(minimalChange("solve = sum", "solve = . sum")).toEqual({ from: 8, to: 8, insert: ". " });
  });

  it("finds a replacement", () => {
    expect(minimalChange("foldr x", "foldl x")).toEqual({ from: 4, to: 5, insert: "l" });
  });

  it("finds a deletion", () => {
    expect(minimalChange("abcabc", "abc")).toEqual({ from: 3, to: 6, insert: "" });
  });

  it("returns null when nothing changed", () => {
    expect(minimalChange("x", "x")).toBeNull();
  });

  it("applies correctly to repeated text", () => {
    const before = "aaaa";
    const after = "aaaaa";
    const change = minimalChange(before, after);
    expect(change).not.toBeNull();
    if (change) {
      expect(before.slice(0, change.from) + change.insert + before.slice(change.to)).toBe(after);
    }
  });
});
