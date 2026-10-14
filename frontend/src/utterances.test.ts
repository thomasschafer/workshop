import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type Card, type JobContext, type Outcome, UtteranceQueue } from "./utterances";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

/** A handler the test finishes by hand, recording what it was asked to do. */
function controlled() {
  const started: { text: string; context: JobContext; finish: (o: Outcome) => void }[] = [];
  const handle = (job: { text: string }, context: JobContext) =>
    new Promise<Outcome>((finish) => {
      context.working("Editing");
      started.push({ text: job.text, context, finish });
    });
  return { started, handle };
}

function queue() {
  const { started, handle } = controlled();
  let cards: Card[] = [];
  const cancelled: string[] = [];
  const q = new UtteranceQueue<null>(
    handle,
    (c) => {
      cards = c;
    },
    (job) => cancelled.push(job.text),
    { lingerMs: 1000, leaveMs: 100 },
  );
  return { q, started, cards: () => cards, cancelled };
}

const statuses = (cards: Card[]) => cards.map((c) => `${c.transcript}:${c.status.kind}`);

describe("UtteranceQueue", () => {
  it("handles utterances one at a time, in order, while more arrive", async () => {
    const { q, started, cards } = queue();
    q.enqueue("first", null);
    q.enqueue("second", null);
    expect(started.map((s) => s.text)).toEqual(["first"]);
    expect(statuses(cards())).toEqual(["first:working", "second:waiting"]);

    started[0]?.finish({ kind: "done", tone: "ok", text: "did it" });
    await vi.advanceTimersByTimeAsync(0);
    expect(started.map((s) => s.text)).toEqual(["first", "second"]);
    expect(statuses(cards())).toEqual(["first:done", "second:working"]);

    // A finished card lingers, then animates away.
    await vi.advanceTimersByTimeAsync(1000);
    expect(cards()[0]?.leaving).toBe(true);
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses(cards())).toEqual(["second:working"]);
  });

  it("keeps questions and problems until dismissed", async () => {
    const { q, started, cards } = queue();
    q.enqueue("change it", null);
    started[0]?.finish({ kind: "asked", question: "Which part?" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses(cards())).toEqual(["change it:asked"]);
    q.dismiss(cards()[0]?.id ?? -1);
    await vi.advanceTimersByTimeAsync(100);
    expect(cards()).toEqual([]);
  });

  it("cancels a waiting utterance without running it", async () => {
    const { q, started, cards, cancelled } = queue();
    q.enqueue("first", null);
    const second = q.enqueue("second", null);
    q.dismiss(second);
    expect(cancelled).toEqual(["second"]);
    started[0]?.finish({ kind: "done", tone: "ok", text: "did it" });
    await vi.advanceTimersByTimeAsync(0);
    expect(started.map((s) => s.text)).toEqual(["first"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses(cards())).toEqual(["first:done"]);
  });

  it("cancels the utterance being worked on, whatever it then reports", async () => {
    const { q, started, cards, cancelled } = queue();
    const id = q.enqueue("slow", null);
    q.dismiss(id);
    expect(started[0]?.context.signal.aborted).toBe(true);
    started[0]?.finish({ kind: "done", tone: "ok", text: "too late" });
    await vi.advanceTimersByTimeAsync(0);
    expect(cancelled).toEqual(["slow"]);
    await vi.advanceTimersByTimeAsync(100);
    expect(cards()).toEqual([]);
  });

  it("shows a handler's failure as a problem, and carries on", async () => {
    let cards: Card[] = [];
    const q = new UtteranceQueue<null>(
      async (job) => {
        if (job.text === "bad") throw new Error("offline");
        return { kind: "done", tone: "ok", text: "fine" };
      },
      (c) => {
        cards = c;
      },
    );
    q.enqueue("bad", null);
    q.enqueue("good", null);
    await vi.advanceTimersByTimeAsync(0);
    expect(cards.map((c) => c.status)).toEqual([
      { kind: "problem", tone: "error", text: "offline" },
      { kind: "done", tone: "ok", text: "fine" },
    ]);
  });

  it("says when everything queued has been handled", async () => {
    const { q, started } = queue();
    await q.idle();
    q.enqueue("first", null);
    const second = q.enqueue("second", null);
    let idle = false;
    void q.idle().then(() => {
      idle = true;
    });
    started[0]?.finish({ kind: "done", tone: "ok", text: "did it" });
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(false);
    q.dismiss(second);
    await vi.advanceTimersByTimeAsync(0);
    expect(idle).toBe(true);
  });

  it("replaces a notice with the same text, and lets passing ones go", async () => {
    const { q, cards } = queue();
    q.notify("error", "Couldn't save, retrying");
    q.notify("error", "Couldn't save, retrying");
    q.notify("info", "Loaded code changed elsewhere.");
    await vi.advanceTimersByTimeAsync(100);
    expect(statuses(cards())).toEqual(["null:problem", "null:done"]);
    await vi.advanceTimersByTimeAsync(1100);
    expect(statuses(cards())).toEqual(["null:problem"]);
  });

  it("does what an offer suggests, then lets it go", async () => {
    const { q, cards } = queue();
    let done = 0;
    q.offer("Part 1 solved. Start part 2?", "Start part 2", () => {
      done++;
    });
    const offer = cards()[0];
    expect(offer?.status).toEqual({
      kind: "offer",
      text: "Part 1 solved. Start part 2?",
      action: "Start part 2",
    });
    q.act(offer?.id ?? -1);
    expect(done).toBe(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(cards()).toEqual([]);
    expect(() => q.act(offer?.id ?? -1)).toThrow("nothing to do");
  });
});
