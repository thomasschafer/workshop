import { afterEach, describe, expect, it, vi } from "vitest";
import {
  askCoach,
  ConnectionError,
  connection,
  followReply,
  ReplyCancelled,
  ReplyLost,
  request,
  sentence,
  TimeoutError,
} from "./api";

afterEach(() => {
  vi.unstubAllGlobals();
  connection.set(true);
  connection.setSlow(false);
});

describe("sentence", () => {
  it("starts the server's messages with a capital", () => {
    expect(sentence("couldn't reach Advent of Code")).toBe("Couldn't reach Advent of Code");
    expect(sentence("Already one")).toBe("Already one");
    expect(sentence("")).toBe("");
  });
});

describe("request timeouts and reachability", () => {
  it("treats a timeout as slow without flipping the app offline", async () => {
    connection.set(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init?: RequestInit) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("aborted", "AbortError")),
            );
          }),
      ),
    );
    await expect(request("GET", "/ping", undefined, { timeoutMs: 25 })).rejects.toBeInstanceOf(
      TimeoutError,
    );
    expect(connection.isOnline).toBe(true);
    expect(connection.isSlow).toBe(true);
  });

  it("marks the app offline on network failure and clears slowness on recovery", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      }),
    );
    await expect(request("GET", "/ping")).rejects.toBeInstanceOf(ConnectionError);
    expect(connection.isOnline).toBe(false);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(null), { status: 200 })),
    );
    await request("GET", "/ping");
    expect(connection.isOnline).toBe(true);
    expect(connection.isSlow).toBe(false);
    expect(connection.snapshot().lastRttMs).toBeGreaterThanOrEqual(0);
  });
});

describe("coach reply streaming and cancellation", () => {
  it("does not turn an aborted read into ReplyLost", async () => {
    const encoder = new TextEncoder();
    const controller = new AbortController();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode(`${JSON.stringify({ delta: "Start " })}\n`));
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    const deltas: string[] = [];
    const pending = askCoach(
      "/discuss",
      { reply_id: "r1" },
      (d) => {
        deltas.push(d);
        controller.abort();
      },
      controller.signal,
    );
    await expect(pending).rejects.toSatisfy(
      (err: unknown) => err instanceof Error && !(err instanceof ReplyLost),
    );
    expect(deltas).toEqual(["Start "]);
  });

  it("rejects with ReplyCancelled when the server ends the stream as cancelled", async () => {
    const encoder = new TextEncoder();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(stream) {
            stream.enqueue(encoder.encode(`${JSON.stringify({ cancelled: true })}\n`));
            stream.close();
          },
        });
        return new Response(body, { status: 200 });
      }),
    );

    await expect(followReply("r2", () => {})).rejects.toBeInstanceOf(ReplyCancelled);
  });
});
