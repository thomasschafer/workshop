import { describe, expect, it } from "vitest";
import { adjustCapabilities, messageToShow, typedEnoughToComplete } from "./lsp";

describe("adjustCapabilities", () => {
  it("stops the client offering pull diagnostics, and adds what Workshop does to what it offers", () => {
    const completion = { completionItem: { snippetSupport: true }, contextSupport: true };
    const initialize = JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        rootUri: "file:///aoc",
        capabilities: { textDocument: { hover: {}, diagnostic: {}, completion }, window: {} },
      },
    });
    expect(JSON.parse(adjustCapabilities(initialize))).toEqual({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        rootUri: "file:///aoc",
        capabilities: {
          textDocument: {
            hover: {},
            codeAction: expect.objectContaining({ resolveSupport: { properties: ["edit"] } }),
            completion: {
              completionItem: {
                snippetSupport: true,
                resolveSupport: { properties: ["additionalTextEdits"] },
              },
              contextSupport: true,
            },
          },
          window: {},
          workspace: { applyEdit: true },
        },
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

describe("messageToShow", () => {
  it("shows errors, and keeps the rest out of the way", () => {
    expect(messageToShow({ type: 1, message: "Failed to load the project" }, false)).toBe(
      "Failed to load the project",
    );
    for (const type of [2, 3, 4]) {
      expect(messageToShow({ type, message: "Finished loading packages." }, false)).toBeNull();
    }
  });

  it("keeps errors to the console while the server's formatting, which says if it fails", () => {
    const failed = "ormolu: Internal Error: ormoluCmd: OrmoluParsingFailed";
    expect(messageToShow({ type: 1, message: failed }, true)).toBeNull();
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
