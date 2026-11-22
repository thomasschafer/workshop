import { describe, expect, it } from "vitest";
import { modeOf, readDraft, replied, turnsOf, waiting, writeDraft } from "./followUps";
import type { Exchange } from "./types";

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

/** An exchange with one question answered aloud, and a second waiting. */
const EXCHANGE: Exchange = {
  limit: 2,
  answer: { text: "Log n", spoken: false, at: 1 },
  questions: [
    { text: "Why?", asked_at: 2, reply: { text: "One path", spoken: true, at: 3 } },
    { text: "And the smallest?", asked_at: 4, reply: null },
  ],
  started_at: 1,
  updated_at: 4,
  next: "reply",
};

describe("an exchange", () => {
  it("is what was said, in order, saying what was aloud", () => {
    expect(turnsOf(EXCHANGE)).toEqual([
      { who: "learner", text: "Log n", spoken: false },
      { who: "tutor", text: "Why?", spoken: false },
      { who: "learner", text: "One path", spoken: true },
      { who: "tutor", text: "And the smallest?", spoken: false },
    ]);
  });

  it("is replied to the way the learner last said something", () => {
    expect(modeOf(EXCHANGE)).toBe("aloud");
    expect(modeOf({ ...EXCHANGE, questions: [] })).toBe("writing");
  });

  it("knows which question is waiting, and which the server has the reply to", () => {
    expect(waiting(EXCHANGE)).toBe(1);
    expect(replied(EXCHANGE, 0)).toBe(true);
    expect(replied(EXCHANGE, 1)).toBe(false);
    expect(waiting({ ...EXCHANGE, questions: [], next: "ask" })).toBeNull();
    expect(waiting({ ...EXCHANGE, next: "mark" })).toBeNull();
  });
});

describe("a reply being written", () => {
  it("is kept for the question it replies to, until it's sent", () => {
    const storage = new MemoryStorage();
    expect(readDraft(storage, "p/a", EXCHANGE)).toBeNull();
    const draft = { question: 1, text: "At the root", mode: "writing" as const };
    writeDraft(storage, "p/a", draft);
    expect(readDraft(storage, "p/a", EXCHANGE)).toEqual(draft);
    // Each card keeps its own.
    expect(readDraft(storage, "p/b", EXCHANGE)).toBeNull();
    // Once the question it was for has been answered, as on another device, it's out of date.
    const answered: Exchange = {
      ...EXCHANGE,
      questions: [
        ...EXCHANGE.questions.slice(0, 1),
        { text: "And the smallest?", asked_at: 4, reply: { text: "Top", spoken: false, at: 5 } },
      ],
      next: "mark",
    };
    expect(readDraft(storage, "p/a", answered)).toBeNull();
    // Nothing written is nothing to keep.
    writeDraft(storage, "p/a", { ...draft, text: " " });
    expect(storage.length).toBe(0);
    writeDraft(storage, "p/a", draft);
    writeDraft(storage, "p/a", null);
    expect(readDraft(storage, "p/a", EXCHANGE)).toBeNull();
  });

  it("isn't trusted if it can't be read", () => {
    const storage = new MemoryStorage();
    storage.setItem("workshop:unsaved:follow-ups:p/a", "{not json");
    expect(readDraft(storage, "p/a", EXCHANGE)).toBeNull();
  });
});
