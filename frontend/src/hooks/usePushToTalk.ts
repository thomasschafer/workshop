import { useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { HoldMethod } from "../dictation";
import { ServerDictation } from "../serverDictation";
import { type Listener, PushToTalk } from "../voice";

interface Options {
  /** How this press is heard. */
  method: () => HoldMethod;
  /** Words to help recognition hear, such as identifiers in the file. */
  vocabulary: () => string[];
  /** Called as a press starts, returning an id for what's said during it. */
  onStart: () => number;
  /**
   * Called with what was heard once the button is released, and the recogniser's own pieces
   * when it revised what it heard.
   */
  onUtterance: (id: number, text: string, pieces: string[]) => void;
  onNotice: (tone: "info" | "error", text: string) => void;
}

/** One press of the talk button, from pressing until its last words have arrived. */
interface Press {
  id: number;
  listener: Listener;
  text: string;
  held: boolean;
  /** Whether audio is being captured yet, after which words are heard. */
  listening: boolean;
  /** How loud it is, from 0 to 1, if the listener can tell. */
  level: number | null;
  startedAt: number;
}

/** How often the sound level is shown, which is plenty for the eye. */
const LEVEL_MS = 80;

/**
 * Where a press is: waiting for the microphone, when words would be lost; listening while held;
 * then hearing the last of it once released.
 */
export type TalkPhase = "starting" | "listening" | "hearing";

function phaseOf(press: Press): TalkPhase {
  if (!press.held) return "hearing";
  return press.listening ? "listening" : "starting";
}

/** A press shorter than this that heard nothing was probably a tap rather than a hold. */
const TAP_MS = 400;

/**
 * Listening while the talk button is held. After it's released, the last words take a moment to
 * arrive. Each press listens on its own, so pressing again straight away never loses the
 * previous one's words.
 */
export function usePushToTalk(options: Options) {
  const [presses, setPresses] = useState<Press[]>([]);
  // Pointer events can arrive faster than state updates, so this is the source of truth.
  const current = useRef<Press[]>([]);
  const latest = useRef(options);
  latest.current = options;

  const update = (change: (presses: Press[]) => Press[]) => {
    current.current = change(current.current);
    setPresses(current.current);
  };
  const held = () => current.current.find((p) => p.held);

  const start = (event: PointerEvent) => {
    event.preventDefault();
    if (held()) return;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      const listener: Listener =
        latest.current.method() === "server" ? new ServerDictation() : new PushToTalk();
      const id = latest.current.onStart();
      const change = (fields: Partial<Press>) =>
        update((presses) => presses.map((p) => (p.id === id ? { ...p, ...fields } : p)));
      update((presses) => [
        ...presses,
        {
          id,
          listener,
          text: "",
          held: true,
          listening: false,
          level: null,
          startedAt: performance.now(),
        },
      ]);
      let levelShownAt = 0;
      listener.start(
        (text) => change({ text }),
        latest.current.vocabulary(),
        () => {
          change({ listening: true });
          // Felt as well as seen, as the moment to start speaking.
          navigator.vibrate?.(25);
        },
        (level) => {
          const now = performance.now();
          if (now - levelShownAt < LEVEL_MS) return;
          levelShownAt = now;
          change({ level });
        },
      );
    } catch (e) {
      latest.current.onNotice("error", e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    const press = held();
    if (!press) return;
    const heldMs = performance.now() - press.startedAt;
    update((presses) => presses.map((p) => (p === press ? { ...p, held: false } : p)));
    const { text, pieces, error, report } = await press.listener.stop();
    // Everything the browser reported, so a wrong edit can be traced to what was heard.
    api.log("speech", `heard ${JSON.stringify({ text, pieces, error, ...report })}`);
    if (error) {
      latest.current.onNotice("error", error);
    } else if (text.trim()) {
      latest.current.onUtterance(press.id, text.trim(), pieces);
    } else if (heldMs < TAP_MS) {
      latest.current.onNotice("info", "Hold the button while you speak.");
    } else {
      latest.current.onNotice("info", "Didn't catch anything.");
    }
    // In the same render as the utterance's card appears, so the one becomes the other.
    update((presses) => presses.filter((p) => p.id !== press.id));
  };

  const heldPress = presses.find((p) => p.held);
  return {
    /** The held press's phase, if the button is held. */
    held: heldPress ? phaseOf(heldPress) : null,
    /** What's being said, or was just said and is still arriving, oldest first. */
    live: presses.map((press) => ({
      id: press.id,
      text: press.text,
      phase: phaseOf(press),
      level: press.level,
    })),
    start,
    stop,
  };
}
