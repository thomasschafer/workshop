import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectionError, connection, request, sentence, TimeoutError } from "./api";

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
