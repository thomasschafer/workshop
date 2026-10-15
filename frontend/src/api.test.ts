import { describe, expect, it } from "vitest";
import { sentence } from "./api";

describe("sentence", () => {
  it("starts the server's messages with a capital", () => {
    expect(sentence("couldn't reach Advent of Code")).toBe("Couldn't reach Advent of Code");
    expect(sentence("Already one")).toBe("Already one");
    expect(sentence("")).toBe("");
  });
});
