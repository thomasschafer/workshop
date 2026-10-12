import { useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { Feedback } from "../feedback";
import { PushToTalk, speechSupported } from "../voice";

interface Options {
  /** Words to help recognition hear, such as identifiers in the file. */
  vocabulary: () => string[];
  /** Called with what was heard once the button is released. */
  onUtterance: (text: string) => void;
  onFeedback: (feedback: Feedback) => void;
}

/** Listening while the talk button is held. */
export function usePushToTalk(options: Options) {
  const ptt = useMemo(() => new PushToTalk(), []);
  const hasSpeech = useMemo(speechSupported, []);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  // Pointer events can arrive faster than state updates, so this is the source of truth.
  const listeningRef = useRef(false);
  const latest = useRef(options);
  latest.current = options;

  const start = (event: PointerEvent) => {
    event.preventDefault();
    if (listeningRef.current) return;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      ptt.start(setInterim, latest.current.vocabulary());
      listeningRef.current = true;
      setListening(true);
      setInterim("");
      navigator.vibrate?.(10);
    } catch (e) {
      latest.current.onFeedback({
        kind: "error",
        text: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const stop = async () => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setListening(false);
    try {
      const text = await ptt.stop();
      setInterim("");
      if (text.trim()) {
        latest.current.onUtterance(text.trim());
      } else {
        api.log("speech", "(nothing heard)");
        latest.current.onFeedback({ kind: "info", text: "Didn't catch anything." });
      }
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      api.log("error", `speech recognition: ${message}`);
      latest.current.onFeedback({ kind: "error", text: message });
    }
  };

  return { hasSpeech, listening, interim, start, stop };
}
