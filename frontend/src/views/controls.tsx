import { useEffect, useRef, useState } from "preact/hooks";
import type { Exchange } from "../api";
import type { Feedback } from "../feedback";
import { speechUnavailableReason } from "../voice";
import { TALK_LABEL } from "./help";

interface Props {
  hidden: boolean;
  feedback: Feedback | null;
  listening: boolean;
  interim: string;
  hasSpeech: boolean;
  /** Whether to show a box for typing what you'd say, in place of or as well as speech. */
  showTyped: boolean;
  /** The edit model's latest question, if it asked one. */
  question: Exchange[] | null;
  replying: boolean;
  onReplying: (replying: boolean) => void;
  onSay: (text: string) => void;
  onTalkStart: (event: PointerEvent) => void;
  onTalkEnd: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRun: () => void;
  keyboard: boolean;
  onToggleKeyboard: () => void;
}

/** Seconds since `startedAt`, updated while it's running, or null when it isn't. */
function useElapsed(startedAt: number | null): number | null {
  const [now, setNow] = useState(() => performance.now());
  useEffect(() => {
    if (startedAt === null) return;
    setNow(performance.now());
    const timer = setInterval(() => setNow(performance.now()), 100);
    return () => clearInterval(timer);
  }, [startedAt]);
  return startedAt === null ? null : Math.max(0, now - startedAt) / 1000;
}

/** Whether an edit has just landed, for a moment after it does. */
function useJustLanded(feedback: Feedback | null): boolean {
  const [landed, setLanded] = useState(false);
  const previous = useRef(feedback);
  useEffect(() => {
    const wasPending = previous.current?.kind === "pending";
    previous.current = feedback;
    if (!wasPending || feedback?.kind !== "ok") return;
    setLanded(true);
    const timer = setTimeout(() => setLanded(false), 900);
    return () => clearTimeout(timer);
  }, [feedback]);
  return landed;
}

/** The thumb-zone controls: what happened, and the buttons for talking, undoing and running. */
export function Controls(props: Props) {
  const { feedback, listening, question, replying } = props;
  const [typed, setTyped] = useState("");
  const elapsed = useElapsed(feedback?.kind === "pending" ? feedback.startedAt : null);
  const landed = useJustLanded(feedback);
  // Talking takes over the button, so a new utterance can be queued while the last is edited.
  const working = elapsed !== null && !listening;

  const submitTyped = (event: Event) => {
    event.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    props.onSay(text);
  };

  return (
    <footer class={`controls ${props.hidden ? "hidden" : ""}`}>
      <div class={`feedback ${feedback?.kind ?? ""}`} aria-live="polite">
        {listening ? (
          <span class="transcript">{props.interim || "Listening…"}</span>
        ) : replying && question ? (
          <>
            <span class="transcript">Replying to: {question[question.length - 1]?.asked}</span>
            <span class="question-actions">
              <span class="muted">Hold the button to answer.</span>
              <button type="button" class="text-button" onClick={() => props.onReplying(false)}>
                Cancel
              </button>
            </span>
          </>
        ) : feedback ? (
          <>
            {feedback.transcript ? <span class="transcript">“{feedback.transcript}”</span> : null}
            {feedback.kind === "pending" ? null : <span class="result">{feedback.text}</span>}
            {question && feedback.kind === "warn" ? (
              <span class="question-actions">
                <button type="button" class="text-button" onClick={() => props.onReplying(true)}>
                  Reply
                </button>
                <span class="muted">or hold the button to start afresh</span>
              </span>
            ) : null}
          </>
        ) : (
          <span class="muted">
            {props.hasSpeech
              ? "Hold to talk. Edits apply at the cursor."
              : speechUnavailableReason()}
          </span>
        )}
      </div>
      {props.showTyped ? (
        <form class="typed" onSubmit={submitTyped}>
          <input
            value={typed}
            onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
            placeholder="Type what you'd say"
            enterKeyHint="send"
          />
        </form>
      ) : null}
      <div class="buttons">
        <button type="button" class="round" aria-label="Undo" onClick={props.onUndo}>
          ↶
        </button>
        <button type="button" class="round" aria-label="Redo" onClick={props.onRedo}>
          ↷
        </button>
        <button
          type="button"
          class={`talk ${listening ? "listening" : ""} ${working ? "working" : ""} ${landed && !listening ? "landed" : ""}`}
          disabled={!props.hasSpeech}
          onPointerDown={props.onTalkStart}
          onPointerUp={props.onTalkEnd}
          onPointerCancel={props.onTalkEnd}
          onContextMenu={(e) => e.preventDefault()}
        >
          {listening ? (
            "Release to send"
          ) : working ? (
            <>
              Editing… <span class="elapsed">{elapsed.toFixed(1)}s</span>
            </>
          ) : replying ? (
            "Hold to reply"
          ) : (
            TALK_LABEL
          )}
        </button>
        <button type="button" class="round" aria-label="Run" onClick={props.onRun}>
          ▶
        </button>
        <button
          type="button"
          class={`round ${props.keyboard ? "selected" : ""}`}
          aria-label={props.keyboard ? "Hide keyboard" : "Type"}
          onClick={props.onToggleKeyboard}
        >
          ⌨
        </button>
      </div>
    </footer>
  );
}
