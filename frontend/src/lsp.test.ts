import { describe, expect, it } from "vitest";
import { quietMessage, withoutPullDiagnostics } from "./lsp";

describe("withoutPullDiagnostics", () => {
  it("stops the client offering pull diagnostics", () => {
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        rootUri: "file:///aoc",
        capabilities: { textDocument: { hover: {}, diagnostic: {} }, window: {} },
      },
    });
    expect(JSON.parse(withoutPullDiagnostics(initialize))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { rootUri: "file:///aoc", capabilities: { textDocument: { hover: {} }, window: {} } },
    });
  });

  it("leaves other messages as they are", () => {
    const change = '{"jsonrpc":"2.0","method":"textDocument/didChange","params":{"diagnostic":{}}}';
    expect(withoutPullDiagnostics(change)).toBe(change);
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
