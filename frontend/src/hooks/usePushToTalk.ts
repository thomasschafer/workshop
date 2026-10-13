import { useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import { PushToTalk, speechSupported } from "../voice";

interface Options {
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
  ptt: PushToTalk;
  text: string;
  held: boolean;
}

/**
 * Listening while the talk button is held. After it's released, the last words take a moment to
 * arrive. Each press listens on its own, so pressing again straight away never loses the
 * previous one's words.
 */
export function usePushToTalk(options: Options) {
  const hasSpeech = useMemo(speechSupported, []);
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
      const ptt = new PushToTalk();
      const id = latest.current.onStart();
      ptt.start(
        (text) => update((presses) => presses.map((p) => (p.id === id ? { ...p, text } : p))),
        latest.current.vocabulary(),
      );
      update((presses) => [...presses, { id, ptt, text: "", held: true }]);
      navigator.vibrate?.(10);
    } catch (e) {
      latest.current.onNotice("error", e instanceof Error ? e.message : String(e));
    }
  };

  const stop = async () => {
    const press = held();
    if (!press) return;
    update((presses) => presses.map((p) => (p === press ? { ...p, held: false } : p)));
    const { text, pieces, error, report } = await press.ptt.stop();
    // Everything the browser reported, so a wrong edit can be traced to what was heard.
    api.log("speech", `heard ${JSON.stringify({ text, pieces, error, ...report })}`);
    if (error) {
      latest.current.onNotice("error", error);
    } else if (text.trim()) {
      latest.current.onUtterance(press.id, text.trim(), pieces);
    } else {
      latest.current.onNotice("info", "Didn't catch anything.");
    }
    // In the same render as the utterance's card appears, so the one becomes the other.
    update((presses) => presses.filter((p) => p.id !== press.id));
  };

  return {
    hasSpeech,
    listening: presses.some((p) => p.held),
    /** What's being said, or was just said and is still arriving, oldest first. */
    live: presses.map(({ id, text }) => ({ id, text })),
    start,
    stop,
  };
}
