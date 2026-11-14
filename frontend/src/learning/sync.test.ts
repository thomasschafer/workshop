import { afterEach, describe, expect, it, vi } from "vitest";
import { newId } from "./local";
import { Learning } from "./sync";
import type { Attempt, Deck } from "./types";

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

const DECK: Deck = {
  limits: { daily_reviews: 40, weekly_minutes: 60, retention: 0.9 },
  progress: { reviews_today: 0, minutes_this_week: 0 },
  day_start: 0,
  week_start: 0,
  tracks: [],
  items: [],
  schedules: {},
  flags: {},
  skills: [],
  problems: [],
};

function attempt(): Attempt {
  return { id: newId(), item: "p/a", answered_at: Date.now(), duration_ms: 1000, rating: "good" };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Learning", () => {
  it("keeps attempts on the device until the server has them", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const offline = new Learning(storage);
    const first = attempt();
    offline.record(first);
    await offline.sync();
    expect(offline.syncStatus).toMatchObject({ pending: 1, offline: true, error: null });

    // A new page, as after a reload, still has it, and sends it.
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(DECK));
      }),
    );
    const reloaded = new Learning(storage);
    expect(reloaded.attempts).toEqual([first]);
    await reloaded.sync();
    expect(sent).toEqual([{ attempts: [first], flags: [] }]);
    expect(reloaded.attempts).toEqual([]);
    expect(reloaded.deck).toEqual(DECK);
    expect(reloaded.syncStatus).toMatchObject({ pending: 0, offline: false });
  });

  it("keeps what's done while a sync is on its way, and sends it next", async () => {
    let answer: (() => void) | null = null;
    const bodies: { attempts: Attempt[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        await new Promise<void>((resolve) => {
          answer = resolve;
        });
        return new Response(JSON.stringify(DECK));
      }),
    );
    const learning = new Learning(new MemoryStorage());
    const first = attempt();
    const second = attempt();
    learning.record(first);
    learning.record(second);
    await vi.waitFor(() => expect(answer).not.toBeNull());
    (answer as unknown as () => void)();
    answer = null;
    await vi.waitFor(() => expect(bodies.length).toBe(2));
    (answer as unknown as () => void)();
    await vi.waitFor(() => expect(learning.syncStatus.pending).toBe(0));
    expect(bodies[0]?.attempts).toEqual([first]);
    expect(bodies[1]?.attempts).toEqual([second]);
  });

  it("keeps attempts the server refuses, saying why", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: "attempt x took less than no time" }), {
            status: 500,
          }),
      ),
    );
    const learning = new Learning(new MemoryStorage());
    learning.record(attempt());
    await learning.sync();
    expect(learning.syncStatus).toMatchObject({
      pending: 1,
      offline: false,
      error: "Attempt x took less than no time",
    });
  });
});
