import { useRef, useState } from "preact/hooks";
import type { DictationMethod } from "../dictation";
import type { TalkPhase } from "../hooks/usePushToTalk";
import { TALK_LABEL } from "./help";

interface Props {
  hidden: boolean;
  /** How what's said reaches Workshop on this device. */
  method: DictationMethod;
  /** Where the held press is, while the button is held. */
  talk: TalkPhase | null;
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
  const { talk, replying, method } = props;
  const [typed, setTyped] = useState("");
  const [composing, setComposing] = useState(false);
  const [composed, setComposed] = useState("");
  const composer = useRef<HTMLTextAreaElement>(null);

  const submitTyped = (event: Event) => {
    event.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    props.onSay(text);
  };

  const openComposer = () => {
    setComposing(true);
    // In the tap itself: phones only open the keyboard for a focus the user started.
    composer.current?.focus();
  };
  const closeComposer = () => {
    setComposing(false);
    setComposed("");
    composer.current?.blur();
  };
  const sendComposed = () => {
    const text = composed.trim();
    if (text) props.onSay(text);
    closeComposer();
  };

  const talkLabel =
    method === "keyboard"
      ? composing
        ? "Send"
        : replying
          ? "Tap to reply"
          : "Tap to dictate"
      : talk === "starting"
        ? "Wait…"
        : talk === "listening"
          ? "Release to send"
          : replying
            ? "Hold to reply"
            : TALK_LABEL;

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
      {method === "keyboard" ? (
        // Always in the page, so a tap can focus it; hidden until then.
        <div class={`composer card ${composing ? "open" : ""}`} aria-hidden={!composing}>
          <textarea
            ref={composer}
            value={composed}
            onInput={(e) => setComposed((e.target as HTMLTextAreaElement).value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendComposed();
              }
            }}
            placeholder="Tap your keyboard's microphone, then speak"
            enterkeyhint="send"
            rows={2}
            tabIndex={composing ? 0 : -1}
          />
          <button type="button" class="text-button" onClick={closeComposer}>
            Cancel
          </button>
        </div>
      ) : null}
      <div class="buttons">
        <button type="button" class="round" aria-label="Undo" onClick={props.onUndo}>
          ↶
        </button>
        <button type="button" class="round" aria-label="Redo" onClick={props.onRedo}>
          ↷
        </button>
        {method === "keyboard" ? (
          <button
            type="button"
            class={`talk ${composing ? "listening" : ""}`}
            onClick={composing ? sendComposed : openComposer}
          >
            {talkLabel}
          </button>
        ) : (
          <button
            type="button"
            class={`talk ${talk ?? ""}`}
            title="Or hold Ctrl"
            onPointerDown={props.onTalkStart}
            onPointerUp={props.onTalkEnd}
            onPointerCancel={props.onTalkEnd}
            onContextMenu={(e) => e.preventDefault()}
          >
            {talkLabel}
          </button>
        )}
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
