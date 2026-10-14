import { useEffect, useRef, useState } from "preact/hooks";
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
  /** What's holding up hearing it, if anything, such as waiting for the server. */
  delay: string | null;
  /** Cancelled after it was released, while it was still being heard. */
  cancelled: boolean;
  startedAt: number;
  /** Settles once every earlier press has handed over what it heard. */
  after: Promise<void>;
  /** Says this press has handed over what it heard, so the next one can. */
  handedOver: () => void;
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
  // What's heard is handed over in the order it was said, even when a later, shorter press is
  // heard first, as Whisper can do.
  const lastHandover = useRef(Promise.resolve());
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
    let listener: Listener;
    let id: number;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      listener = latest.current.method() === "server" ? new ServerDictation() : new PushToTalk();
      id = latest.current.onStart();
    } catch (e) {
      latest.current.onNotice("error", e instanceof Error ? e.message : String(e));
      return;
    }
    const change = (fields: Partial<Press>) =>
      update((presses) => presses.map((p) => (p.id === id ? { ...p, ...fields } : p)));
    const after = lastHandover.current;
    let handedOver = () => {};
    lastHandover.current = new Promise((resolve) => {
      handedOver = resolve;
    });
    update((presses) => [
      ...presses,
      {
        id,
        listener,
        text: "",
        held: true,
        listening: false,
        level: null,
        delay: null,
        cancelled: false,
        startedAt: performance.now(),
        after,
        handedOver,
      },
    ]);
    let levelShownAt = 0;
    try {
      listener.start({
        vocabulary: latest.current.vocabulary(),
        onInterim: (text) => change({ text }),
        onListening: () => {
          change({ listening: true });
          // Felt as well as seen, as the moment to start speaking.
          navigator.vibrate?.(25);
        },
        onLevel: (level) => {
          const now = performance.now();
          if (now - levelShownAt < LEVEL_MS) return;
          levelShownAt = now;
          change({ level });
        },
        onDelay: (delay) => change({ delay }),
      });
    } catch (e) {
      // Nothing to hear, so the press ends here rather than holding up the ones after it.
      update((presses) => presses.filter((p) => p.id !== id));
      void after.then(() => {
        latest.current.onNotice("error", e instanceof Error ? e.message : String(e));
        handedOver();
      });
    }
  };

  const stop = async () => {
    const press = held();
    if (!press) return;
    const heldMs = performance.now() - press.startedAt;
    update((presses) => presses.map((p) => (p === press ? { ...p, held: false } : p)));
    try {
      const { text, pieces, error, hint, report } = await press.listener.stop();
      await press.after;
      const cancelled = current.current.find((p) => p.id === press.id)?.cancelled ?? false;
      // Everything the browser reported, so a wrong edit can be traced to what was heard.
      api.log("speech", `heard ${JSON.stringify({ text, pieces, error, cancelled, ...report })}`);
      if (cancelled) {
        // Nothing more to say: the card just goes.
      } else if (error) {
        latest.current.onNotice("error", error);
      } else if (text.trim()) {
        latest.current.onUtterance(press.id, text.trim(), pieces);
      } else if (hint) {
        latest.current.onNotice("info", hint);
      } else if (heldMs < TAP_MS) {
        latest.current.onNotice("info", "Hold the button while you speak.");
      } else {
        latest.current.onNotice("info", "Didn't catch anything.");
      }
    } catch (e) {
      await press.after;
      latest.current.onNotice("error", e instanceof Error ? e.message : String(e));
    } finally {
      // In the same render as the utterance's card appears, so the one becomes the other.
      update((presses) => presses.filter((p) => p.id !== press.id));
      press.handedOver();
    }
  };

  // Leaving the page, such as by locking the phone, can lose the button's release, which would
  // leave the microphone on; what's been said so far is kept.
  useEffect(() => {
    const hidden = () => {
      if (document.visibilityState === "hidden") void stop();
    };
    document.addEventListener("visibilitychange", hidden);
    return () => document.removeEventListener("visibilitychange", hidden);
  }, []);

  /** Abandons hearing a press that's been released, such as when the server is slow. */
  const cancel = (id: number) => {
    const press = current.current.find((p) => p.id === id && !p.held);
    if (!press || press.cancelled) return;
    update((presses) => presses.map((p) => (p.id === id ? { ...p, cancelled: true } : p)));
    press.listener.cancel();
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
      delay: press.delay,
    })),
    start,
    stop,
    cancel,
  };
}
