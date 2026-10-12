import { describe, expect, it } from "vitest";
import { matchCommand, parseNumber } from "./commands";

describe("parseNumber", () => {
  it.each([
    ["12", 12],
    ["twelve", 12],
    ["forty two", 42],
    ["forty-two", 42],
    ["one hundred and four", 104],
    ["a hundred", null],
    ["banana", null],
  ])("%s", (words, expected) => {
    expect(parseNumber(words)).toBe(expected);
  });
});

describe("matchCommand", () => {
  const snippets = ["Starter", "parse ints"];

  it.each([
    ["Undo.", { kind: "undo" }],
    ["redo that", { kind: "redo" }],
    ["Run the sample", { kind: "run", input: "sample" }],
    ["run on the real input", { kind: "run", input: "real" }],
    ["Go to line forty two", { kind: "gotoLine", line: 42 }],
    ["go to line 7", { kind: "gotoLine", line: 7 }],
    ["next error", { kind: "nextError" }],
    ["install it", { kind: "install", package: null }],
    ["Install unordered containers", { kind: "install", package: "unordered-containers" }],
    ["install the package numpy", { kind: "install", package: "numpy" }],
    ["previous error", { kind: "previousError" }],
    ["show the problem", { kind: "tab", tab: "problem" }],
    ["insert snippet parse ints", { kind: "snippet", name: "parse ints" }],
    ["snippet starter", { kind: "snippet", name: "Starter" }],
    ["submit", { kind: "submit" }],
  ])("%s", (utterance, expected) => {
    expect(matchCommand(utterance, snippets)).toEqual(expected);
  });

  it.each(["undo the last map", "map read", "go to line banana", "snippet unknown", "run"])(
    "leaves %s for the model",
    (utterance) => {
      expect(matchCommand(utterance, snippets)).toBeNull();
    },
  );
});
