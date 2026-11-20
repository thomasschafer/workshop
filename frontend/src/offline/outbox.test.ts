import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbox } from "./outbox";

class MemoryStorage implements Storage {
  private readonly values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  clear() {
    this.values.clear();
  }
  getItem(key: string) {
    return this.values.get(key) ?? null;
  }
  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.values.delete(key);
  }
  setItem(key: string, value: string) {
    this.values.set(key, value);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Outbox", () => {
  it("keeps mistake tags across reloads, coalesces duplicates, and flushes when online", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );

    const offline = new Outbox(storage);
    offline.enqueueMistakeTag("m-1", "misread");
    offline.enqueueMistakeTag("m-1", "off-by-one");
    offline.enqueueMistakeTag("m-2", "concept-gap");
    await offline.flush();
    expect(offline.pending).toBe(2);

    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({ mistakes: [], common: [], error_types: [], skills: {}, focus: [] }),
        );
      }),
    );

    const reloaded = new Outbox(storage);
    expect(reloaded.pending).toBe(2);
    await reloaded.flush();
    expect(reloaded.pending).toBe(0);
    expect(sent).toEqual([
      { id: "m-1", error_type: "off-by-one" },
      { id: "m-2", error_type: "concept-gap" },
    ]);
  });
});
