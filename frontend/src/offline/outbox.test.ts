import { afterEach, describe, expect, it, vi } from "vitest";
import { Outbox } from "./outbox";

function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    clear: () => data.clear(),
    getItem: (k: string) => data.get(k) ?? null,
    key: (i: number) => [...data.keys()][i] ?? null,
    removeItem: (k: string) => {
      data.delete(k);
    },
    setItem: (k: string, v: string) => {
      data.set(k, v);
    },
  };
}

const emptyDeck = {
  items: [],
  schedules: {},
  flags: {},
  retirements: {},
  limits: { daily_reviews: 40, daily_new: 10 },
  progress: { new_today: 0, reviewed_today: 0 },
  week: { minutes: 0, target: 0 },
  focus: [],
};

const sampleSession = (plan: string, version = 1) => ({
  mode: "solve" as const,
  step: "plan" as const,
  language: "haskell" as const,
  part: 0,
  plans: [],
  prediction: null,
  plan,
  passed: false,
  runs: 0,
  submissions: 0,
  hints: 0,
  no_twist: null,
  started_at: 1000,
  updated_at: 1100,
  version,
});

describe("Outbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("chains open -> coalesced update -> finish cleanly and persists conflicts across reload", async () => {
    const storage = memoryStorage();
    let online = false;
    const sent: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (!online) throw new TypeError("Failed to fetch");
        const body = JSON.parse(String(init.body)) as {
          coding_events: { id: string; item: string; kind: string }[];
          mistake_tags: { id: string }[];
        };
        sent.push(body);
        return new Response(
          JSON.stringify({
            deck: emptyDeck,
            coding_results: body.coding_events.map((ev) =>
              ev.id === "ev-conflict"
                ? {
                    id: ev.id,
                    item: ev.item,
                    status: "conflict",
                    current: sampleSession("From desk", 5),
                  }
                : { id: ev.id, item: ev.item, status: "applied" },
            ),
            mistake_tag_results: body.mistake_tags.map((t) => ({ id: t.id, ok: true })),
          }),
        );
      }),
    );

    const outbox = new Outbox(storage);
    outbox.enqueueMistakeTag("m1", "concept-gap");
    // Wait for the offline flush attempt to settle so m1 #1 is no longer in-flight.
    await outbox.flush();
    outbox.enqueueMistakeTag("m1", "edge-case");
    await outbox.flush();
    outbox.enqueueCodingEvent(
      {
        kind: "session_opened",
        id: "ev-open",
        item: "sample/islands",
        mode: "solve",
        language: "haskell",
        no_twist: null,
        started_at: 1000,
      },
      false,
    );
    const r1 = outbox.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "ev-1",
        item: "sample/islands",
        base_version: 1,
        session: sampleSession("draft 1", 1),
        at: 1100,
      },
      false,
    );
    expect(r1.coalesced).toBe(false);
    const r2 = outbox.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "ev-conflict",
        item: "sample/islands",
        base_version: 2,
        session: sampleSession("draft 2", 1),
        at: 1200,
      },
      false,
    );
    expect(r2.coalesced).toBe(true);
    outbox.enqueueCodingEvent(
      {
        kind: "finished",
        id: "ev-fin",
        item: "sample/islands",
        base_version: null,
        rating: "good",
        plan: "draft 2",
        duration_ms: 0,
        answered_at: 1500,
      },
      false,
    );

    await outbox.flush();
    // 1 coalesced mistake tag + open + 1 coalesced session_updated + finished.
    expect(outbox.pending).toBe(4);

    online = true;
    await outbox.flush();
    expect(outbox.pending).toBe(0);
    expect(sent).toHaveLength(1);
    const payload = sent[0] as {
      coding_events: { id: string; kind: string; base_version?: number }[];
    };
    // Coalesced session_updated kept the earlier base_version (1).
    expect(payload.coding_events[1]?.base_version).toBe(1);
    expect(payload.coding_events[2]?.kind).toBe("finished");

    // Conflicts persist in storage across reload.
    const reloaded = new Outbox(storage);
    expect(reloaded.conflictFor("sample/islands")?.plan).toBe("From desk");
    expect(reloaded.issues()).toHaveLength(1);
  });

  it("publishes applied server sessions and drops superseded unsent session updates", async () => {
    const storage = memoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              deck: emptyDeck,
              coding_results: [
                {
                  id: "ev-upd-1",
                  item: "sample/islands",
                  status: "applied",
                  session: sampleSession("Synced plan", 2),
                },
              ],
              mistake_tag_results: [],
            }),
          ),
      ),
    );

    const ob = new Outbox(storage);
    const appliedVersions: number[] = [];
    ob.onSessionApplied("sample/islands", (s) => {
      if (s.version !== undefined) appliedVersions.push(s.version);
    });
    ob.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "ev-upd-1",
        item: "sample/islands",
        base_version: 1,
        session: sampleSession("Synced plan", 1),
        at: 1100,
      },
      false,
    );
    expect(ob.hasPendingCodingEvents("sample/islands")).toBe(true);
    await ob.flush();
    expect(ob.hasPendingCodingEvents("sample/islands")).toBe(false);
    expect(appliedVersions).toEqual([2]);

    ob.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "ev-upd-stale",
        item: "sample/islands",
        base_version: 2,
        session: sampleSession("Old draft", 2),
        at: 1200,
      },
      false,
    );
    ob.dropUnsentSessionUpdates("sample/islands");
    expect(ob.hasPendingCodingEvents("sample/islands")).toBe(false);
  });

  it("retries on 500/401, drops with recorded issue on 400, merges across tabs, and prevents concurrent duplicate sends", async () => {
    const storage = memoryStorage();
    let statusToReturn = 500;
    let calls = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        calls++;
        if (statusToReturn === 200) {
          return new Response(
            JSON.stringify({ deck: emptyDeck, coding_results: [], mistake_tag_results: [] }),
          );
        }
        return new Response(JSON.stringify({ error: `HTTP ${statusToReturn}` }), {
          status: statusToReturn,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    // Two tabs sharing the same storage never overwrite each other.
    const tabA = new Outbox(storage);
    const tabB = new Outbox(storage);
    tabA.enqueueCodingEvent(
      {
        kind: "finished",
        id: "tab-a-fin",
        item: "sample/a",
        base_version: null,
        rating: "good",
        plan: null,
        duration_ms: 0,
        answered_at: 1000,
      },
      false,
    );
    tabB.enqueueCodingEvent(
      {
        kind: "finished",
        id: "tab-b-fin",
        item: "sample/b",
        base_version: null,
        rating: "hard",
        plan: null,
        duration_ms: 0,
        answered_at: 1001,
      },
      false,
    );
    expect(tabA.pending).toBe(2);
    expect(tabB.pending).toBe(2);

    // Concurrency guard: acquiring a batch prevents a second concurrent sender and prevents
    // coalescing into an in-flight event.
    const batch = tabA.tryAcquireBatch();
    expect(batch).not.toBeNull();
    expect(tabA.tryAcquireBatch()).toBeNull();
    if (batch) tabA.releaseBatch(batch);

    // 500 keeps events in the outbox for retry.
    statusToReturn = 500;
    await tabA.flush();
    expect(tabA.pending).toBe(2);

    // 401 also keeps events for retry.
    statusToReturn = 401;
    await tabA.flush();
    expect(tabA.pending).toBe(2);

    // Permanent 400 drops the batch and records a durable issue.
    statusToReturn = 400;
    await tabA.flush();
    expect(tabA.pending).toBe(0);
    expect(tabA.issues()).toHaveLength(1);
    expect(calls).toBe(3);
  });

  it("retries instead of dropping a batch when the server returns an HTML 401", async () => {
    const storage = memoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response("<!doctype html><h1>Workshop</h1>", {
            status: 401,
            headers: { "content-type": "text/html; charset=utf-8" },
          }),
      ),
    );
    const ob = new Outbox(storage);
    ob.enqueueCodingEvent(
      {
        kind: "finished",
        id: "html-401-fin",
        item: "sample/a",
        base_version: null,
        rating: "good",
        plan: null,
        duration_ms: 0,
        answered_at: 1000,
      },
      false,
    );
    await ob.flush();
    expect(ob.pending).toBe(1);
    expect(ob.issues()).toHaveLength(0);
  });

  it("flushes events queued while an earlier sync batch is still in flight", async () => {
    const storage = memoryStorage();
    const resolvers: (() => void)[] = [];
    const sentBatches: { mistake_tags: { mistake_id: string }[] }[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          mistake_tags: { id: string; mistake_id: string }[];
        };
        sentBatches.push(body);
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return new Response(
          JSON.stringify({
            deck: emptyDeck,
            coding_results: [],
            mistake_tag_results: body.mistake_tags.map((t) => ({ id: t.id, ok: true })),
          }),
        );
      }),
    );

    const ob = new Outbox(storage);
    ob.enqueueMistakeTag("m1", "concept-gap");
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    // Enqueue a second event while batch 1 is still in flight.
    ob.enqueueMistakeTag("m2", "edge-case");
    expect(ob.pending).toBe(2);

    // Completing batch 1 must automatically drain batch 2 without waiting for a reload.
    resolvers[0]?.();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.();
    await vi.waitFor(() => expect(ob.pending).toBe(0));

    expect(sentBatches).toHaveLength(2);
    expect(sentBatches[0]?.mistake_tags.map((t) => t.mistake_id)).toEqual(["m1"]);
    expect(sentBatches[1]?.mistake_tags.map((t) => t.mistake_id)).toEqual(["m2"]);
  });

  it("stops loudly instead of spinning when storage cannot persist the cleared outbox", async () => {
    vi.useFakeTimers();
    try {
      const inner = memoryStorage();
      let failWrites = false;
      const flakyStorage: Storage = {
        get length() {
          return inner.length;
        },
        clear: () => inner.clear(),
        getItem: (k: string) => inner.getItem(k),
        key: (i: number) => inner.key(i),
        removeItem: (k: string) => inner.removeItem(k),
        setItem: (k: string, v: string) => {
          if (failWrites && k === "workshop:outbox") {
            throw new DOMException("Quota exceeded", "QuotaExceededError");
          }
          inner.setItem(k, v);
        },
      };

      const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          mistake_tags: { id: string }[];
        };
        return new Response(
          JSON.stringify({
            deck: emptyDeck,
            coding_results: [],
            mistake_tag_results: body.mistake_tags.map((t) => ({ id: t.id, ok: true })),
          }),
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const ob = new Outbox(flakyStorage);
      ob.enqueueCodingEvent(
        {
          kind: "finished",
          id: "stuck-1",
          item: "sample/a",
          base_version: null,
          rating: "good",
          plan: null,
          duration_ms: 0,
          answered_at: 1000,
        },
        false,
      );
      failWrites = true;

      await ob.flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(ob.issues().some((i) => i.item === "sync" && i.kind === "error")).toBe(true);

      // Once storage recovers, the scheduled backoff retry succeeds cleanly.
      failWrites = false;
      await vi.advanceTimersByTimeAsync(5_000);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(ob.pending).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});
