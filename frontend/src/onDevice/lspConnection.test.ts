import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  AUTOMATIC_SERVER_TIMEOUT_MS,
  type LanguageServerBackend,
  LanguageServerConnection,
  type LanguageServerStatus,
} from "../editor";
import { bundleCacheName, bundleFileUrl, bundleForLanguage } from "./bundles";

class FakeEventTarget {
  private readonly listeners = new Map<string, Set<(ev: unknown) => void>>();

  addEventListener(type: string, listener: (ev: unknown) => void): void {
    let set = this.listeners.get(type);
    if (!set) {
      set = new Set();
      this.listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: (ev: unknown) => void): void {
    this.listeners.get(type)?.delete(listener);
  }

  dispatch(type: string, event: unknown = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

class FakeWebSocket extends FakeEventTarget {
  static instances: FakeWebSocket[] = [];
  readonly sent: string[] = [];
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.dispatch("close");
  }

  simulateOpen(): void {
    this.dispatch("open");
  }

  simulateMessage(payload: unknown): void {
    this.dispatch("message", { data: JSON.stringify(payload) });
  }
}

class FakeLspWorker extends FakeEventTarget {
  readonly received: { method?: string; id?: number; params?: unknown }[] = [];
  terminated = false;

  postMessage(data: unknown): void {
    if (typeof data !== "string") return;
    const msg = JSON.parse(data) as { method?: string; id?: number; params?: unknown };
    this.received.push(msg);
    if (msg.method === "initialize" && msg.id !== undefined) {
      queueMicrotask(() => {
        if (this.terminated) return;
        this.dispatch("message", {
          data: JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              capabilities: {
                textDocumentSync: 1,
                hoverProvider: true,
                completionProvider: { triggerCharacters: ["."] },
                signatureHelpProvider: { triggerCharacters: [" ", "("] },
              },
            },
          }),
        });
      });
    }
  }

  terminate(): void {
    this.terminated = true;
  }
}

function seedCachedHaskellBundle(): void {
  const bundle = bundleForLanguage("haskell");
  if (!bundle) throw new Error("expected a configured haskell bundle");
  const bucketName = bundleCacheName(bundle);
  const files = new Map<string, Response>();
  for (const file of bundle.files) {
    files.set(bundleFileUrl(bundle, file.name), new Response("ok", { status: 200 }));
  }
  const cacheStorage = {
    open: async (name: string) => ({
      match: async (req: string) => (name === bucketName ? files.get(req)?.clone() : undefined),
    }),
    keys: async () => [bucketName],
  };
  vi.stubGlobal("caches", cacheStorage);
}

async function flushMicrotasks(): Promise<void> {
  for (let i = 0; i < 16; i++) {
    await Promise.resolve();
  }
}

describe("LanguageServerConnection sticky local/server switching", () => {
  let fakeDoc: FakeEventTarget & { visibilityState: string };

  beforeEach(() => {
    FakeWebSocket.instances = [];
    seedCachedHaskellBundle();
    fakeDoc = Object.assign(new FakeEventTarget(), { visibilityState: "visible" });
    vi.stubGlobal("document", fakeDoc);
    vi.stubGlobal("location", { protocol: "http:", host: "localhost:3000" });
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("navigator", { onLine: true });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("connects directly to the local worker in local mode without opening a WebSocket", async () => {
    const workers: FakeLspWorker[] = [];
    const statuses: LanguageServerStatus[] = [];
    const backends: LanguageServerBackend[] = [];

    const conn = new LanguageServerConnection(
      "file:///aoc",
      undefined,
      (s) => statuses.push(s),
      () => {},
      () => {},
      "/api/lsp",
      {
        languageId: "haskell",
        mode: "local",
        onBackend: (b) => backends.push(b),
        createWorker: () => {
          const w = new FakeLspWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
      },
    );
    conn.setHelpers([{ name: "Aoc.hs", text: "module Aoc where" }]);

    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(workers).toHaveLength(1);
    expect(backends).toEqual(["local"]);
    expect(statuses).toContain("ready");
    expect(conn.client.serverCapabilities?.hoverProvider).toBe(true);
    expect(conn.client.serverCapabilities?.documentFormattingProvider).toBeUndefined();
    expect(workers[0]?.received.some((m) => m.method === "workshop/setHelpers")).toBe(true);
    conn.close();
  });

  it("starts local immediately when offline in automatic mode", async () => {
    vi.stubGlobal("navigator", { onLine: false });
    const workers: FakeLspWorker[] = [];
    const backends: LanguageServerBackend[] = [];

    const conn = new LanguageServerConnection(
      "file:///aoc",
      undefined,
      () => {},
      () => {},
      () => {},
      "/api/lsp",
      {
        languageId: "haskell",
        mode: "automatic",
        onBackend: (b) => backends.push(b),
        createWorker: () => {
          const w = new FakeLspWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
      },
    );

    await flushMicrotasks();

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(workers).toHaveLength(1);
    expect(backends).toEqual(["local"]);
    conn.close();
  });

  it("fails over to local after bounded timeout in automatic mode and stays sticky", async () => {
    vi.useFakeTimers();
    const workers: FakeLspWorker[] = [];
    const backends: LanguageServerBackend[] = [];
    const statuses: LanguageServerStatus[] = [];

    const conn = new LanguageServerConnection(
      "file:///aoc",
      undefined,
      (s) => statuses.push(s),
      () => {},
      () => {},
      "/api/lsp",
      {
        languageId: "haskell",
        mode: "automatic",
        onBackend: (b) => backends.push(b),
        createWorker: () => {
          const w = new FakeLspWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
      },
    );

    await flushMicrotasks();
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(workers).toHaveLength(0);
    expect(backends).toEqual(["server"]);

    await vi.advanceTimersByTimeAsync(AUTOMATIC_SERVER_TIMEOUT_MS + 10);
    await flushMicrotasks();

    expect(FakeWebSocket.instances[0]?.closed).toBe(true);
    expect(workers).toHaveLength(1);
    expect(backends).toEqual(["server", "local"]);
    expect(statuses.at(-1)).toBe("ready");
    expect(conn.client.serverCapabilities?.hoverProvider).toBe(true);
    conn.close();
  });

  it("switches cleanly from server to sticky local on drop, then back via reconnectServer", async () => {
    const workers: FakeLspWorker[] = [];
    const backends: LanguageServerBackend[] = [];
    const statuses: LanguageServerStatus[] = [];

    const conn = new LanguageServerConnection(
      "file:///aoc",
      undefined,
      (s) => statuses.push(s),
      () => {},
      () => {},
      "/api/lsp",
      {
        languageId: "haskell",
        mode: "automatic",
        onBackend: (b) => backends.push(b),
        createWorker: () => {
          const w = new FakeLspWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
      },
    );

    await flushMicrotasks();
    const ws1 = FakeWebSocket.instances[0];
    if (!ws1) throw new Error("expected first WebSocket");
    ws1.simulateOpen();
    const initReq1 = JSON.parse(ws1.sent[0] ?? "{}") as { id: number };
    ws1.simulateMessage({
      jsonrpc: "2.0",
      id: initReq1.id,
      result: { capabilities: { hoverProvider: true, documentFormattingProvider: true } },
    });
    await flushMicrotasks();

    expect(backends).toEqual(["server"]);
    expect(conn.client.serverCapabilities?.documentFormattingProvider).toBe(true);

    // Server connection drops: fails over to sticky local worker and refreshes capabilities.
    ws1.close();
    await flushMicrotasks();

    expect(backends).toEqual(["server", "local"]);
    expect(workers).toHaveLength(1);
    expect(conn.client.serverCapabilities?.documentFormattingProvider).toBeUndefined();
    expect(conn.client.serverCapabilities?.hoverProvider).toBe(true);

    // Explicit user action reconnects to server and restores server capabilities.
    conn.reconnectServer();
    await flushMicrotasks();

    expect(workers[0]?.terminated).toBe(true);
    const ws2 = FakeWebSocket.instances[1];
    if (!ws2) throw new Error("expected second WebSocket");
    ws2.simulateOpen();
    const initReq2 = JSON.parse(ws2.sent[0] ?? "{}") as { id: number };
    ws2.simulateMessage({
      jsonrpc: "2.0",
      id: initReq2.id,
      result: { capabilities: { hoverProvider: true, documentFormattingProvider: true } },
    });
    await flushMicrotasks();

    expect(backends).toEqual(["server", "local", "server"]);
    expect(statuses.at(-1)).toBe("ready");
    expect(conn.client.serverCapabilities?.documentFormattingProvider).toBe(true);
    conn.close();
  });

  it("never uses the local worker in server-only mode", async () => {
    const workers: FakeLspWorker[] = [];
    const backends: LanguageServerBackend[] = [];

    const conn = new LanguageServerConnection(
      "file:///aoc",
      undefined,
      () => {},
      () => {},
      () => {},
      "/api/lsp",
      {
        languageId: "haskell",
        mode: "server",
        onBackend: (b) => backends.push(b),
        createWorker: () => {
          const w = new FakeLspWorker();
          workers.push(w);
          return w as unknown as Worker;
        },
      },
    );

    await flushMicrotasks();
    FakeWebSocket.instances[0]?.close();
    await flushMicrotasks();

    expect(workers).toHaveLength(0);
    expect(backends).toEqual(["server"]);
    conn.close();
  });
});
