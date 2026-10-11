import { describe, expect, it } from "vitest";
import { mergeSegments, PushToTalk } from "./voice";

describe("mergeSegments", () => {
  it("joins consecutive pieces", () => {
    expect(mergeSegments(["map read", " dot lines"])).toBe("map read dot lines");
  });

  it("collapses Android's growing copies of the same sentence", () => {
    const segments = [
      "can",
      "can you",
      "can you replace",
      "can you replace the brackets",
      "can you replace the brackets online six and seven with dollars after print",
    ];
    expect(mergeSegments(segments)).toBe(
      "can you replace the brackets online six and seven with dollars after print",
    );
  });

  it("uses Android's latest guess when it revises earlier words", () => {
    // From a real session: each piece restates the sentence, sometimes shorter than before.
    const segments = [
      "can you replace the dollars online six and seven with open",
      "can you replace the dollars online six and seven with",
      "can you replace the dollars online six and seven with open",
      "can you replace the dollars online six and seven with open (and",
      "can you replace the dollars online six and seven with open bracket and",
      "can you replace the dollars online six and seven with open bracket and add",
      "can you replace the dollars online six and seven with open (and add a",
      "can you replace the dollars online six and seven with (and add a",
      "can you replace the dollars online six and seven with open (and add a closed)",
      "can you replace the dollars online six and seven with open (and add a closed) at the end of both Lines",
    ];
    expect(mergeSegments(segments)).toBe(
      "can you replace the dollars online six and seven with open (and add a closed) at the end of both Lines",
    );
  });

  it("joins pieces that happen to start with the same word", () => {
    expect(mergeSegments(["map read", "map show"])).toBe("map read map show");
  });

  it("handles a repeated final copy and casing changes", () => {
    expect(mergeSegments(["Fold are", "fold are plus zero", "fold are plus zero"])).toBe(
      "fold are plus zero",
    );
  });

  it("keeps a new sentence after a growing one", () => {
    expect(mergeSegments(["before", "before that sum", "dot"])).toBe("before that sum dot");
  });

  it("ignores empty results", () => {
    expect(mergeSegments(["", "  ", "undo"])).toBe("undo");
  });
});

describe("PushToTalk", () => {
  /** Stands in for the browser's recognition, letting tests say what was heard and end it. */
  class FakeRecognition extends EventTarget {
    static sessions: FakeRecognition[] = [];
    lang = "";
    continuous = false;
    interimResults = false;
    onresult: ((event: never) => void) | null = null;
    onerror: ((event: never) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() {
      super();
      FakeRecognition.sessions.push(this);
    }
    start() {}
    stop() {
      this.onend?.();
    }
    abort() {
      this.onend?.();
    }
    hear(...segments: string[]) {
      const results = segments.map((text) =>
        Object.assign([{ transcript: text }], { isFinal: true }),
      );
      this.onresult?.({ results } as never);
    }
    fail(error: string) {
      this.onerror?.({ error } as never);
      this.onend?.();
    }
  }

  const latest = () =>
    FakeRecognition.sessions[FakeRecognition.sessions.length - 1] as FakeRecognition;

  it("keeps listening when the browser ends recognition while the button is held", async () => {
    FakeRecognition.sessions = [];
    const ptt = new PushToTalk(FakeRecognition as never);
    const interim: string[] = [];
    ptt.start((t) => interim.push(t));
    latest().hear("create a function called parse from string to int");
    // The browser decides the user has finished, but the button is still held.
    latest().onend?.();
    expect(FakeRecognition.sessions).toHaveLength(2);
    latest().hear("and then replace the undefined with sum dot map parse");
    expect(await ptt.stop()).toBe(
      "create a function called parse from string to int and then replace the undefined with sum dot map parse",
    );
    expect(interim.at(-1)).toContain("and then replace");
  });

  it("reports errors such as a refused microphone", async () => {
    FakeRecognition.sessions = [];
    const ptt = new PushToTalk(FakeRecognition as never);
    ptt.start(() => {});
    latest().fail("not-allowed");
    expect(FakeRecognition.sessions).toHaveLength(1);
    await expect(ptt.stop()).rejects.toThrow("Microphone access was refused");
  });

  it("ignores silence", async () => {
    FakeRecognition.sessions = [];
    const ptt = new PushToTalk(FakeRecognition as never);
    ptt.start(() => {});
    latest().fail("no-speech");
    expect(await ptt.stop()).toBe("");
  });
});
