import { useRef } from "preact/hooks";
import { useDictation } from "../hooks/useDictation";
import { usePushToTalk } from "../hooks/usePushToTalk";

/**
 * Dictating into a text box, as Workshop dictates code: hold the button and speak, and what's
 * heard is added to the end. Where only the phone's keyboard can hear, its microphone does the
 * same in the box itself.
 */
export function DictateButton({
  serverDictation,
  onHeard,
  onNotice,
}: {
  serverDictation: boolean;
  onHeard: (text: string) => void;
  onNotice: (text: string) => void;
}) {
  const { dictationMethod } = useDictation(serverDictation);
  const presses = useRef(0);
  const talk = usePushToTalk({
    method: () => (dictationMethod === "server" ? "server" : "browser"),
    vocabulary: () => [],
    onStart: () => ++presses.current,
    onUtterance: (_id, text) => {
      if (text.trim()) onHeard(text.trim());
    },
    onNotice: (_tone, text) => onNotice(text),
  });
  if (dictationMethod === "keyboard") {
    return <p class="muted coding-hint">To dictate, use your keyboard's microphone.</p>;
  }
  const label =
    talk.held === "starting"
      ? "Wait…"
      : talk.held === "listening"
        ? "Release to add it"
        : "Hold to dictate";
  const hearing = talk.live.find((press) => press.text)?.text ?? null;
  return (
    <span class="coding-dictate">
      <button
        type="button"
        class={`pill talk ${talk.held ?? ""}`}
        onPointerDown={talk.start}
        onPointerUp={() => void talk.stop()}
        onPointerCancel={() => void talk.stop()}
      >
        {label}
      </button>
      {hearing ? <span class="muted coding-hearing">{hearing}</span> : null}
    </span>
  );
}
