import { useEffect, useRef, useState } from "preact/hooks";
import type { Turn } from "../api";

interface Props {
  turns: Turn[];
  models: string[];
  model: string;
  thinking: boolean;
  /** The reply so far, while it's being written. */
  partial: string;
  error: string | null;
  onModel: (model: string) => void;
  onSend: (text: string) => void;
  onClear: () => void;
}

export function DiscussView({
  turns,
  models,
  model,
  thinking,
  partial,
  error,
  onModel,
  onSend,
  onClear,
}: Props) {
  const [draft, setDraft] = useState("");
  const end = useRef<HTMLDivElement>(null);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [turns.length, thinking, partial]);

  const send = (event: Event) => {
    event.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    onSend(text);
  };

  return (
    <div class="pane discuss">
      <div class="discuss-header">
        <div class="segmented">
          {models.map((m) => (
            <button
              type="button"
              key={m}
              class={m === model ? "selected" : ""}
              onClick={() => onModel(m)}
            >
              {m}
            </button>
          ))}
        </div>
        {turns.length > 0 ? (
          <button type="button" class="text-button" onClick={onClear}>
            Clear
          </button>
        ) : null}
      </div>
      {turns.length === 0 ? (
        <p class="muted">
          Stuck? Ask about the puzzle or your code. The coach can see both, won't edit anything, and
          won't give the answer away unless you ask.
        </p>
      ) : null}
      <div class="turns">
        {turns.map((t, i) => (
          <div key={i} class={`turn ${t.speaker}`}>
            {t.text}
          </div>
        ))}
        {thinking ? (
          partial ? (
            <div class="turn coach writing">{partial}</div>
          ) : (
            <div class="turn coach muted">Thinking…</div>
          )
        ) : null}
        {error ? <div class="error-text">{error}</div> : null}
        <div ref={end} />
      </div>
      <form class="discuss-input" onSubmit={send}>
        <input
          value={draft}
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          placeholder="Or type a question"
          enterKeyHint="send"
        />
      </form>
    </div>
  );
}
