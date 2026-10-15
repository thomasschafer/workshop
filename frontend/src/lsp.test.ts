import { describe, expect, it } from "vitest";
import { withoutPullDiagnostics } from "./lsp";

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
