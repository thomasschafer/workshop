import type { Transport } from "@codemirror/lsp-client";
import { describe, expect, it, vi } from "vitest";
import {
  adjustCapabilities,
  LanguageClient,
  LanguageServerError,
  messageToShow,
  typedEnoughToComplete,
} from "./lsp";

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

describe("LanguageClient", () => {
  /** A connection to a server that never answers, with the methods of what's sent over it. */
  function silentServer(): { transport: Transport; sent: string[] } {
    const sent: string[] = [];
    const transport: Transport = {
      send: (message) => sent.push((JSON.parse(message) as { method: string }).method),
      subscribe: () => {},
      unsubscribe: () => {},
    };
    return { transport, sent };
  }

  /** What's rejected and not handled while `run` runs, and for a moment after. */
  async function unhandledDuring(run: () => Promise<void>): Promise<unknown[]> {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", record);
    try {
      await run();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", record);
    }
    return unhandled;
  }

  it("drops what was waiting to be sent when the connection closes before the server's greeted", async () => {
    const { transport, sent } = silentServer();
    const unhandled = await unhandledDuring(async () => {
      vi.useFakeTimers();
      try {
        const client = new LanguageClient({ rootUri: "file:///code", timeout: 30_000 });
        client.connect(transport);
        client.notification("textDocument/didOpen", {});
        client.notification("textDocument/didChange", {});
        client.disconnect();
        // Long enough for the greeting to time out.
        await vi.advanceTimersByTimeAsync(31_000);
      } finally {
        vi.useRealTimers();
      }
    });
    expect(unhandled).toEqual([]);
    expect(sent).toEqual(["initialize"]);
  });

  it("sends notifications once the server's greeted, in order with requests", async () => {
    let receive: (message: string) => void = () => {};
    const sent: string[] = [];
    const transport: Transport = {
      send: (message) => {
        const parsed = JSON.parse(message) as { id?: number; method: string };
        sent.push(parsed.method);
        if (parsed.method === "initialize") {
          queueMicrotask(() =>
            receive(
              JSON.stringify({ jsonrpc: "2.0", id: parsed.id, result: { capabilities: {} } }),
            ),
          );
        }
      },
      subscribe: (handler) => {
        receive = handler;
      },
      unsubscribe: () => {},
    };
    const client = new LanguageClient({ rootUri: "file:///code" });
    client.connect(transport);
    client.notification("textDocument/didOpen", {});
    await client.initializing;
    client.notification("textDocument/didChange", {});
    void client.request("textDocument/hover", {}).catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sent).toEqual([
      "initialize",
      "initialized",
      "textDocument/didOpen",
      "textDocument/didChange",
      "textDocument/hover",
    ]);
  });

  it("fails a request the server answers with an error with that error's message and code", async () => {
    let receive: (message: string) => void = () => {};
    const transport: Transport = {
      send: (message) => {
        const { id, method } = JSON.parse(message) as { id?: number; method: string };
        if (id === undefined) return;
        const reply =
          method === "initialize"
            ? { result: { capabilities: {} } }
            : { error: { code: -32803, message: "can't rename that" } };
        queueMicrotask(() => receive(JSON.stringify({ jsonrpc: "2.0", id, ...reply })));
      },
      subscribe: (handler) => {
        receive = handler;
      },
      unsubscribe: () => {},
    };
    const client = new LanguageClient({ rootUri: "file:///code" });
    client.connect(transport);
    await client.initializing;
    const failure = await client.request("textDocument/rename", {}).catch((e: unknown) => e);
    expect(failure).toBeInstanceOf(LanguageServerError);
    expect(failure).toMatchObject({ message: "can't rename that", code: -32803 });
  });

  it("fails requests at once when the server's been given up on", async () => {
    const client = new LanguageClient({ rootUri: "file:///code" });
    client.connect(silentServer().transport);
    client.unavailable = "the language server, `nothing`, isn't installed";
    await expect(client.request("textDocument/hover", {})).rejects.toThrow("isn't installed");
  });
});
