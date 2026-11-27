import { afterEach, describe, expect, it, vi } from "vitest";
import { outbox } from "../offline/outbox";
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
  focus: [],
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
    expect(sent).toEqual([
      { attempts: [first], flags: [], retirements: [], lesson_completions: [], lesson_skips: [] },
    ]);
    expect(reloaded.attempts).toEqual([]);
    expect(reloaded.deck).toEqual(DECK);
    expect(reloaded.syncStatus).toMatchObject({ pending: 0, offline: false });
  });

  it("forgets follow-ups marked, so the deck on the device doesn't offer them again", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ ...DECK, follow_ups: ["p/a", "p/b"] }))),
    );
    const learning = new Learning(storage);
    await learning.sync();
    learning.forgetFollowUps("p/a");
    learning.forgetFollowUps("p/none");
    expect(learning.deck?.follow_ups).toEqual(["p/b"]);
    expect(new Learning(storage).deck?.follow_ups).toEqual(["p/b"]);
  });

  it("counts an attempt the server recorded until the deck has it, even after a reload", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify(DECK))),
    );
    const learning = new Learning(storage);
    await learning.sync();
    // Marked by the grader, then the page goes before the sync that follows is answered.
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise<Response>(() => {})),
    );
    const marked = attempt();
    learning.recordedOnServer(marked);
    expect(learning.attempts).toEqual([marked]);

    const sent: { attempts: Attempt[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(DECK));
      }),
    );
    const reloaded = new Learning(storage);
    expect(reloaded.attempts).toEqual([marked]);
    // It's the server's already, so there's nothing to send.
    expect(reloaded.syncStatus.pending).toBe(0);
    await reloaded.sync();
    expect(sent).toEqual([
      { attempts: [], flags: [], retirements: [], lesson_completions: [], lesson_skips: [] },
    ]);
    expect(reloaded.attempts).toEqual([]);
  });

  it("counts an attempt the server recorded until a sync begun after it", async () => {
    const answers: (() => void)[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        await new Promise<void>((resolve) => answers.push(resolve));
        return new Response(JSON.stringify(DECK));
      }),
    );
    const learning = new Learning(new MemoryStorage());
    // A sync begun before the grader recorded it sends back a deck without it.
    const opening = learning.sync();
    const marked = attempt();
    learning.recordedOnServer(marked);
    learning.recordedOnServer(marked);
    expect(learning.attempts).toEqual([marked]);
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers[0]?.();
    await opening;
    expect(learning.attempts).toEqual([marked]);
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    answers[1]?.();
    await vi.waitFor(() => expect(learning.attempts).toEqual([]));
    expect(answers).toHaveLength(2);
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

  it("resolves a sync asked for while one's on its way once what's waiting has been sent", async () => {
    const answers: (() => void)[] = [];
    const bodies: { attempts: Attempt[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        bodies.push(JSON.parse(String(init.body)));
        await new Promise<void>((resolve) => answers.push(resolve));
        return new Response(JSON.stringify(DECK));
      }),
    );
    const learning = new Learning(new MemoryStorage());
    // A sync with nothing to send, such as a screen's as it opens, is on its way when an
    // answer's given, and the screen that follows asks for one to show what the server has.
    const opening = learning.sync();
    const given = attempt();
    learning.record(given);
    let synced = false;
    const following = learning.sync().then(() => {
      synced = true;
    });
    await vi.waitFor(() => expect(answers).toHaveLength(1));
    answers[0]?.();
    await opening;
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    expect(synced).toBe(false);
    expect(bodies[1]?.attempts).toEqual([given]);
    answers[1]?.();
    await following;
    expect(learning.syncStatus.pending).toBe(0);
    expect(bodies).toHaveLength(2);
  });

  it("retires an item offline with the attempt that retired it, and sends both once", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const offline = new Learning(storage);
    const easy: Attempt = { ...attempt(), rating: "easy" };
    offline.retire(easy);
    await offline.sync();
    // The retirement goes with its attempt, so one thing is waiting.
    expect(offline.syncStatus).toMatchObject({ pending: 1, offline: true });
    expect(offline.retirementChanges).toEqual([
      { id: easy.id, item: "p/a", at: easy.answered_at, retired: true },
    ]);
    expect(() => offline.retire(attempt())).toThrow("rated easy");

    const sent: { attempts: Attempt[]; retirements: unknown[] }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(DECK));
      }),
    );
    const reloaded = new Learning(storage);
    expect(reloaded.syncStatus.pending).toBe(1);
    await reloaded.sync();
    expect(sent).toEqual([
      {
        attempts: [easy],
        flags: [],
        retirements: offline.retirementChanges,
        lesson_completions: [],
        lesson_skips: [],
      },
    ]);
    expect(reloaded.retirementChanges).toEqual([]);
    expect(reloaded.syncStatus.pending).toBe(0);

    // Bringing it back is a change of its own.
    reloaded.bringBack("p/a", 5);
    await vi.waitFor(() => expect(sent.length).toBe(2));
    expect(sent[1]?.retirements).toEqual([
      { id: expect.any(String), item: "p/a", at: 5, retired: false },
    ]);
  });

  it("reads what an older Workshop kept on the device, with no retirements", async () => {
    const storage = new MemoryStorage();
    const first = attempt();
    storage.setItem(
      "workshop:learning",
      JSON.stringify({ deck: DECK, attempts: [first], flags: [] }),
    );
    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(JSON.stringify(DECK));
      }),
    );
    const learning = new Learning(storage);
    expect(learning.syncStatus.pending).toBe(1);
    await learning.sync();
    expect(sent).toEqual([
      { attempts: [first], flags: [], retirements: [], lesson_completions: [], lesson_skips: [] },
    ]);
  });

  it("keeps lesson completions offline until synced", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      }),
    );
    const offline = new Learning(storage);
    const completion = {
      id: newId(),
      lesson: "sample/binary-heaps",
      completed_at: Date.now(),
      duration_ms: 120_000,
    };
    const skip = {
      id: newId(),
      lesson: "sample/other-lesson",
      skipped_at: Date.now(),
    };
    offline.completeLesson(completion);
    // Duplicate id is ignored.
    offline.completeLesson(completion);
    offline.skipLesson(skip);
    offline.skipLesson(skip);
    await offline.sync();
    expect(offline.syncStatus).toMatchObject({ pending: 2, offline: true, error: null });

    const sent: unknown[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        sent.push(JSON.parse(String(init.body)));
        return new Response(
          JSON.stringify({
            ...DECK,
            lesson_completions: { "sample/binary-heaps": [completion.completed_at] },
            lesson_skips: { "sample/other-lesson": [skip.skipped_at] },
          }),
        );
      }),
    );
    const reloaded = new Learning(storage);
    expect(reloaded.lessonCompletions).toEqual([completion]);
    expect(reloaded.lessonSkips).toEqual([skip]);
    await reloaded.sync();
    expect(sent).toEqual([
      {
        attempts: [],
        flags: [],
        retirements: [],
        lesson_completions: [completion],
        lesson_skips: [skip],
      },
    ]);
    expect(reloaded.lessonCompletions).toEqual([]);
    expect(reloaded.lessonSkips).toEqual([]);
    expect(reloaded.syncStatus).toMatchObject({ pending: 0, offline: false });
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

  it("flushes outbox events queued while a piggybacked Learning.sync is in flight", async () => {
    const storage = new MemoryStorage();
    vi.stubGlobal("localStorage", storage);
    const resolvers: (() => void)[] = [];
    const sentTags: string[][] = [];

    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body)) as {
          mistake_tags?: { id: string; mistake_id: string }[];
        };
        const tags = body.mistake_tags ?? [];
        sentTags.push(tags.map((t) => t.mistake_id));
        await new Promise<void>((resolve) => resolvers.push(resolve));
        return new Response(
          JSON.stringify({
            deck: DECK,
            coding_results: [],
            mistake_tag_results: tags.map((t) => ({ id: t.id, ok: true })),
          }),
        );
      }),
    );

    const ob = outbox();
    ob.syncFromStorage();
    // Seed an outbox event directly in storage so Learning.sync acquires it as a piggybacked batch.
    storage.setItem(
      "workshop:outbox",
      JSON.stringify([
        { kind: "mistake_tag", id: "m1-ev", mistakeId: "m1", errorType: "edge-case", at: 1 },
      ]),
    );
    ob.syncFromStorage();

    const learning = new Learning(storage);
    const syncing = learning.sync();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));

    // Queue a second outbox event while Learning.sync holds batchInFlight.
    ob.enqueueMistakeTag("m2", "concept-gap");
    expect(ob.pending).toBe(2);

    // Finish Learning.sync; the queued m2 event must flush automatically.
    resolvers[0]?.();
    await syncing;
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));
    resolvers[1]?.();
    await vi.waitFor(() => expect(ob.pending).toBe(0));
    expect(sentTags).toEqual([["m1"], ["m2"]]);
  });
});
