import { CompletionContext } from "@codemirror/autocomplete";
import { LSPPlugin, type Transport } from "@codemirror/lsp-client";
import { EditorState, type Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adjustCapabilities,
  LanguageClient,
  LanguageServerError,
  messageToShow,
  typedEnoughToComplete,
} from "./lsp";
import { serverCompletionSource } from "./lspCompletion";

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
                labelDetailsSupport: true,
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

interface ViewPluginSpec {
  readonly plugin: { create(view: EditorView, arg: unknown): unknown };
  readonly arg: unknown;
}

/** Instantiates every ViewPlugin inside a CodeMirror extension against a minimal EditorView. */
function mountExtensionPlugins(extension: Extension, state: EditorState): EditorView {
  const specs: ViewPluginSpec[] = [];
  const seen = new Set<unknown>();
  const walk = (ext: unknown): void => {
    if (!ext || typeof ext !== "object" || seen.has(ext)) return;
    seen.add(ext);
    if (Array.isArray(ext)) {
      for (const item of ext) walk(item);
      return;
    }
    if ("extension" in ext) walk((ext as { extension: unknown }).extension);
    if ("value" in ext) {
      const val = (ext as { value: unknown }).value;
      if (
        val &&
        typeof val === "object" &&
        "plugin" in val &&
        typeof (val as ViewPluginSpec).plugin?.create === "function"
      ) {
        specs.push(val as ViewPluginSpec);
      }
    }
  };
  walk(extension);

  const mounted = new Map<unknown, unknown>();
  const view = {
    state,
    plugin: (p: unknown) => mounted.get(p) ?? null,
    dispatch: () => {},
  } as unknown as EditorView;
  for (const spec of specs) {
    mounted.set(spec.plugin, spec.plugin.create(view, spec.arg));
  }
  return view;
}

describe("LSP documentation sanitization", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("escapes raw HTML and strips unsafe links in completion and hover/signature docToHTML", async () => {
    const payload =
      "Docs <img src=x onerror=alert(1)> <script>alert(1)</script> and [click](javascript:alert(1)) and [safe](https://example.com)";
    let receive: (message: string) => void = () => {};
    const transport: Transport = {
      send: (message) => {
        const { id, method } = JSON.parse(message) as { id?: number; method: string };
        if (id === undefined) return;
        const reply =
          method === "initialize"
            ? { result: { capabilities: { completionProvider: { triggerCharacters: ["."] } } } }
            : {
                result: {
                  items: [
                    {
                      label: "foo",
                      documentation: { kind: "markdown", value: payload },
                    },
                  ],
                },
              };
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

    const state = EditorState.create({ doc: "fo" });
    const view = mountExtensionPlugins(client.plugin("file:///code/a.py", "python"), state);
    const plugin = LSPPlugin.get(view);
    if (plugin === null) throw new Error("expected LSPPlugin to be mounted");

    // Direct docToHTML (used by hoverTooltips and signatureHelp as well as completions).
    const rendered = plugin.docToHTML({ kind: "markdown", value: payload });
    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("<script");
    expect(rendered).not.toContain("javascript:");
    expect(rendered).toContain("&lt;img");
    expect(rendered).toContain('href="https://example.com"');

    const plain = plugin.docToHTML({ kind: "plaintext", value: "a < b & c > d\n<script>" });
    expect(plain).toBe("a &lt; b &amp; c &gt; d<br>&lt;script&gt;");

    // Completion tooltip DOM constructed by serverCompletionSource.
    const fakeEl = { className: "", innerHTML: "" };
    vi.stubGlobal("document", { createElement: () => fakeEl });
    const context = new CompletionContext(state, 2, true, view);
    const result = await serverCompletionSource(context);
    const option = result?.options[0];
    if (!option || typeof option.info !== "function") {
      throw new Error("expected completion option with info renderer");
    }
    const infoNode = option.info(option) as unknown as typeof fakeEl;
    expect(infoNode.innerHTML).not.toContain("<img");
    expect(infoNode.innerHTML).not.toContain("<script");
    expect(infoNode.innerHTML).not.toContain("javascript:");
    expect(infoNode.innerHTML).toContain('href="https://example.com"');
  });
});
