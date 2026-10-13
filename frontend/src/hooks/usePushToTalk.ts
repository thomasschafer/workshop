import { useMemo, useRef, useState } from "preact/hooks";
import { api } from "../api";
import type { Feedback } from "../feedback";
import { PushToTalk, speechSupported } from "../voice";

interface Options {
  /** Words to help recognition hear, such as identifiers in the file. */
  vocabulary: () => string[];
  /**
   * Called with what was heard once the button is released, and the recogniser's own pieces
   * when it revised what it heard.
   */
  onUtterance: (text: string, pieces: string[]) => void;
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
    const heard = await ptt.stop();
    setInterim("");
    // Everything the browser reported, so a wrong edit can be traced to what was heard.
    const { text, pieces, error, report } = heard;
    api.log("speech", `heard ${JSON.stringify({ text, pieces, error, ...report })}`);
    if (error) {
      latest.current.onFeedback({ kind: "error", text: error });
    } else if (text.trim()) {
      latest.current.onUtterance(text.trim(), pieces);
    } else {
      latest.current.onFeedback({ kind: "info", text: "Didn't catch anything." });
    }
  };

  return { hasSpeech, listening, interim, start, stop };
}
