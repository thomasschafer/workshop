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

describe("Outbox", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("coalesces repeated mistake tags and session updates, flushes via /api/sync, and surfaces conflicts", async () => {
    const storage = memoryStorage();
    let online = false;
    const sent: unknown[] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        if (!online) throw new TypeError("Failed to fetch");
        const body = JSON.parse(String(init.body)) as {
          coding_events: { id: string; item: string }[];
          mistake_tags: { id: string }[];
        };
        sent.push(body);
        return new Response(
          JSON.stringify({
            deck: {
              items: [],
              schedules: {},
              flags: {},
              retirements: {},
              limits: { daily_reviews: 40, daily_new: 10 },
              progress: { new_today: 0, reviewed_today: 0 },
              week: { minutes: 0, target: 0 },
              focus: [],
            },
            coding_results: body.coding_events.map((ev) =>
              ev.id === "ev-conflict"
                ? {
                    id: ev.id,
                    item: ev.item,
                    status: "conflict",
                    current: {
                      mode: "solve",
                      step: "code",
                      language: "haskell",
                      prediction: null,
                      plan: "From desk",
                      passed: false,
                      runs: 0,
                      submissions: 0,
                      hints: 0,
                      no_twist: null,
                      started_at: 1000,
                      updated_at: 2000,
                      version: 5,
                    },
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
    outbox.enqueueMistakeTag("m1", "edge-case");
    outbox.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "ev-1",
        item: "sample/islands",
        base_version: 1,
        session: {
          mode: "solve",
          step: "plan",
          language: "haskell",
          prediction: null,
          plan: "draft 1",
          passed: false,
          runs: 0,
          submissions: 0,
          hints: 0,
          no_twist: null,
          started_at: 1000,
          updated_at: 1100,
          version: 1,
        },
        at: 1100,
      },
      false,
    );
    outbox.enqueueCodingEvent(
      {
        kind: "session_updated",
        id: "ev-conflict",
        item: "sample/islands",
        base_version: 1,
        session: {
          mode: "solve",
          step: "plan",
          language: "haskell",
          prediction: null,
          plan: "draft 2",
          passed: false,
          runs: 0,
          submissions: 0,
          hints: 0,
          no_twist: null,
          started_at: 1000,
          updated_at: 1200,
          version: 1,
        },
        at: 1200,
      },
      false,
    );

    await outbox.flush();
    // Coalesced: 1 mistake tag + 1 session_updated event.
    expect(outbox.pending).toBe(2);

    const reloaded = new Outbox(storage);
    expect(reloaded.pending).toBe(2);

    online = true;
    await reloaded.flush();
    expect(reloaded.pending).toBe(0);
    expect(sent).toHaveLength(1);
    const payload = sent[0] as {
      mistake_tags: { mistake_id: string; error_type: string | null }[];
      coding_events: { id: string; session: { plan: string } }[];
    };
    expect(payload.mistake_tags).toHaveLength(1);
    expect(payload.mistake_tags[0]?.error_type).toBe("edge-case");
    expect(payload.coding_events).toHaveLength(1);
    expect(payload.coding_events[0]?.session.plan).toBe("draft 2");
    expect(reloaded.conflictFor("sample/islands")?.plan).toBe("From desk");
  });
});
