import { describe, expect, it } from "vitest";
import { adjustCapabilities, quietMessage, typedEnoughToComplete } from "./lsp";
import { EXTRA_CAPABILITIES } from "./lspActions";

describe("adjustCapabilities", () => {
  it("stops the client offering pull diagnostics, and offers code actions", () => {
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        rootUri: "file:///aoc",
        capabilities: { textDocument: { hover: {}, diagnostic: {} }, window: {} },
      },
    });
    expect(JSON.parse(adjustCapabilities(initialize))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        rootUri: "file:///aoc",
        capabilities: { textDocument: { hover: {}, ...EXTRA_CAPABILITIES }, window: {} },
      },
    });
  });

  it("leaves other messages as they are", () => {
    const change = '{"jsonrpc":"2.0","method":"textDocument/didChange","params":{"diagnostic":{}}}';
    expect(adjustCapabilities(change)).toBe(change);
  });

  it("refuses an initialize without capabilities", () => {
    expect(() => adjustCapabilities('{"method":"initialize","params":{}}')).toThrow();
  });
});

describe("quietMessage", () => {
  it("shows errors, and keeps the rest out of the way", () => {
    expect(quietMessage({ type: 1, message: "Failed to load the project" })).toBe(false);
    for (const type of [2, 3, 4]) {
      expect(quietMessage({ type, message: "Finished loading packages." })).toBe(true);
    }
  });
});

describe("typedEnoughToComplete", () => {
  it("waits for more than a word's first letter", () => {
    expect(typedEnoughToComplete("  | otherwise = T")).toBe(false);
    expect(typedEnoughToComplete("  | otherwise = Tr")).toBe(true);
    expect(typedEnoughToComplete("x'")).toBe(true);
  });

  it("leaves what isn't part of a word to the server's trigger characters", () => {
    expect(typedEnoughToComplete("Map.")).toBe(true);
    expect(typedEnoughToComplete("")).toBe(true);
  });
});
