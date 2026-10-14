import { describe, expect, it } from "vitest";
import { joinSegments, PushToTalk, telling } from "./voice";

describe("joinSegments", () => {
  it("joins consecutive pieces, with no guesswork", () => {
    expect(joinSegments(["map read", " dot lines"])).toEqual({
      text: "map read dot lines",
      revised: false,
    });
  });

  it("collapses Android's growing copies of the same sentence", () => {
    const segments = [
      "can",
      "can you",
      "can you replace",
      "can you replace the brackets",
      "can you replace the brackets online six and seven with dollars after print",
    ];
    expect(joinSegments(segments)).toEqual({
      text: "can you replace the brackets online six and seven with dollars after print",
      revised: true,
    });
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
    expect(joinSegments(segments).text).toBe(
      "can you replace the dollars online six and seven with open (and add a closed) at the end of both Lines",
    );
  });

  it("joins pieces that happen to start with the same word", () => {
    expect(joinSegments(["map read", "map show"])).toEqual({
      text: "map read map show",
      revised: false,
    });
  });

  it("handles a repeated final copy and casing changes", () => {
    expect(joinSegments(["Fold are", "fold are plus zero", "fold are plus zero"]).text).toBe(
      "fold are plus zero",
    );
  });

  it("keeps a new sentence after a growing one, noting the guesswork", () => {
    expect(joinSegments(["before", "before that sum", "dot"])).toEqual({
      text: "before that sum dot",
      revised: true,
    });
  });

  it("ignores empty results", () => {
    expect(joinSegments(["", "  ", "undo"])).toEqual({ text: "undo", revised: false });
  });
});

describe("telling", () => {
  it("drops pieces that a later one carries on from", () => {
    // From a real session on Android.
    expect(
      telling([
        "can you",
        "can you add",
        "can you add a two here so it's constitute",
        "no",
        "no const",
        "no const too",
      ]),
    ).toEqual(["can you add a two here so it's constitute", "no const too"]);
  });

  it("keeps a piece the recogniser changed its mind about", () => {
    expect(telling(["add filter brackets", "add filter (greater than 100)"])).toEqual([
      "add filter brackets",
      "add filter (greater than 100)",
    ]);
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
    const heard = await ptt.stop();
    expect(heard.text).toBe(
      "create a function called parse from string to int and then replace the undefined with sum dot map parse",
    );
    // Pieces that simply follow on need no second opinion.
    expect(heard.pieces).toEqual([]);
    expect(heard.report.sessions.map((s) => s.events)).toEqual([1, 1]);
    expect(interim.at(-1)).toContain("and then replace");
  });

  it("says when the browser has started capturing audio", () => {
    FakeRecognition.sessions = [];
    const ptt = new PushToTalk(FakeRecognition as never);
    let listening = false;
    ptt.start(
      () => {},
      [],
      () => {
        listening = true;
      },
    );
    expect(listening).toBe(false);
    (latest() as unknown as { onaudiostart: () => void }).onaudiostart();
    expect(listening).toBe(true);
  });

  it("reports errors such as a refused microphone", async () => {
    FakeRecognition.sessions = [];
    const ptt = new PushToTalk(FakeRecognition as never);
    ptt.start(() => {});
    latest().fail("not-allowed");
    expect(FakeRecognition.sessions).toHaveLength(1);
    const heard = await ptt.stop();
    expect(heard.error).toContain("Microphone access was refused");
    expect(heard.report.sessions[0]?.errors).toEqual(["not-allowed"]);
  });

  it("ignores silence", async () => {
    FakeRecognition.sessions = [];
    const ptt = new PushToTalk(FakeRecognition as never);
    ptt.start(() => {});
    latest().fail("no-speech");
    const heard = await ptt.stop();
    expect(heard).toMatchObject({ text: "", error: null });
    expect(heard.report.sessions[0]).toEqual({ results: [], events: 0, errors: ["no-speech"] });
  });

  it("passes on the recogniser's pieces when it revised what it heard", async () => {
    FakeRecognition.sessions = [];
    const ptt = new PushToTalk(FakeRecognition as never);
    ptt.start(() => {});
    latest().hear("add filter", "add filter brackets", "add filter (greater than 100)");
    const heard = await ptt.stop();
    expect(heard.text).toBe("add filter (greater than 100)");
    // "add filter" only grew into "add filter brackets", so it's left out.
    expect(heard.pieces).toEqual(["add filter brackets", "add filter (greater than 100)"]);
  });
});
