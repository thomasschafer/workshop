import { useState } from "preact/hooks";
import { TALK_LABEL } from "./help";

interface Props {
  hidden: boolean;
  listening: boolean;
  hasSpeech: boolean;
  /** Whether to show a box for typing what you'd say, in place of or as well as speech. */
  showTyped: boolean;
  /** Whether the next utterance answers the edit model's question. */
  replying: boolean;
  onSay: (text: string) => void;
  onTalkStart: (event: PointerEvent) => void;
  onTalkEnd: () => void;
  onUndo: () => void;
  onRedo: () => void;
  onRun: () => void;
  keyboard: boolean;
  onToggleKeyboard: () => void;
}

/**
 * The thumb-zone controls. What was heard and what happened to it show in cards above them, so
 * the talk button is always free for the next utterance.
 */
export function Controls(props: Props) {
  const { listening, replying } = props;
  const [typed, setTyped] = useState("");

  const submitTyped = (event: Event) => {
    event.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    props.onSay(text);
  };

  return (
    <footer class={`controls ${props.hidden ? "hidden" : ""}`}>
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
          class={`talk ${listening ? "listening" : ""}`}
          disabled={!props.hasSpeech}
          onPointerDown={props.onTalkStart}
          onPointerUp={props.onTalkEnd}
          onPointerCancel={props.onTalkEnd}
          onContextMenu={(e) => e.preventDefault()}
        >
          {listening ? "Release to send" : replying ? "Hold to reply" : TALK_LABEL}
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
