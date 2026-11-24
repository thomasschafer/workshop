import { describe, expect, it } from "vitest";
import { ConnectionError, type OfflineDay } from "../api";
import type { CachedAocPuzzle } from "./db";
import { YearSyncManager } from "./yearSync";

function makeDay(year: number, day: number): OfflineDay {
  return {
    year,
    day,
    template: "main = pure ()",
    empty_version: "empty-v0",
    puzzle: {
      day,
      problem: {
        title: `Day ${day}`,
        parts_html: [`<p>Day ${day}</p>`],
        text: `Day ${day}`,
        answers: [],
        stars: 0,
        final_star: null,
        suggested_sample_answers: [],
        suggested_sample_blocks: [],
        blocks: [],
      },
      input: `input-${day}`,
      code: null,
      notes: null,
      file_uri: `file:///work/${year}/day${day}.hs`,
      meta: {
        cursor: 0,
        sample_blocks: [null, null],
        sample_inputs: [null, null],
        sample_answers: [null, null],
        version: 0,
      },
    },
  };
}

describe("YearSyncManager", () => {
  it("saves each day incrementally, keeps partial progress on network drop, and resumes from the next uncached day", async () => {
    const store = new Map<string, CachedAocPuzzle>();
    const fetched: number[] = [];
    let failOnDay: number | null = 3;

    const manager = new YearSyncManager({
      getPuzzle: async (y, d) => store.get(`${y}-${d}`) ?? null,
      mergePuzzle: async (y, d, patch) => {
        const key = `${y}-${d}`;
        const prev = store.get(key) ?? { key, year: y, day: d, updatedAt: 0 };
        store.set(key, { ...prev, ...patch, updatedAt: Date.now() });
      },
      deleteYear: async (y) => {
        for (const [k, v] of store) {
          if (v.year === y) store.delete(k);
        }
      },
      fetchDay: async (y, d) => {
        fetched.push(d);
        if (d === failOnDay) throw new ConnectionError("Can't reach the server.");
        return makeDay(y, d);
      },
      ensureHelpers: async () => {},
    });

    await manager.start(2018, [1, 2, 3, 4]);
    expect(fetched).toEqual([1, 2, 3]);
    expect(store.has("2018-1")).toBe(true);
    expect(store.has("2018-2")).toBe(true);
    expect(store.has("2018-3")).toBe(false);
    const partial = manager.get(2018);
    expect(partial?.active).toBe(false);
    expect(partial?.completed).toBe(2);
    expect(partial?.error).toContain("Saved 2 of 4 days");
    expect(partial?.error).toContain("day 3");

    // Resume: skips days 1 & 2 already saved on device, fetches only 3 & 4.
    failOnDay = null;
    await manager.start(2018, [1, 2, 3, 4]);
    expect(fetched).toEqual([1, 2, 3, 3, 4]);
    expect(store.has("2018-3")).toBe(true);
    expect(store.has("2018-4")).toBe(true);
    expect(manager.get(2018)?.error).toBeNull();
    expect(manager.get(2018)?.completed).toBe(2);
  });

  it("pauses cleanly without losing already-saved days and removes a year cleanly", async () => {
    const store = new Map<string, CachedAocPuzzle>();
    let resolveDay2!: (value: OfflineDay) => void;

    const manager = new YearSyncManager({
      getPuzzle: async (y, d) => store.get(`${y}-${d}`) ?? null,
      mergePuzzle: async (y, d, patch) => {
        const key = `${y}-${d}`;
        const prev = store.get(key) ?? { key, year: y, day: d, updatedAt: 0 };
        store.set(key, { ...prev, ...patch, updatedAt: Date.now() });
      },
      deleteYear: async (y) => {
        for (const [k, v] of store) {
          if (v.year === y) store.delete(k);
        }
      },
      fetchDay: (y, d, signal) => {
        if (d === 1) return Promise.resolve(makeDay(y, d));
        return new Promise<OfflineDay>((resolve, reject) => {
          resolveDay2 = resolve;
          signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      },
      ensureHelpers: async () => {},
    });

    const running = manager.start(2019, [1, 2, 3]);
    // Wait until day 1 completes and day 2 is in flight.
    await new Promise((r) => setTimeout(r, 10));
    expect(store.has("2019-1")).toBe(true);
    expect(manager.get(2019)?.currentDay).toBe(2);

    manager.pause(2019);
    resolveDay2(makeDay(2019, 2));
    await running;

    expect(manager.get(2019)?.paused).toBe(true);
    expect(manager.get(2019)?.error).toBeNull();
    expect(store.has("2019-1")).toBe(true);
    expect(store.has("2019-2")).toBe(false);

    await manager.removeYear(2019);
    expect(store.size).toBe(0);
    expect(manager.get(2019)).toBeNull();
  });
});
