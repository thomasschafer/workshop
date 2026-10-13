import { useEffect, useRef, useState } from "preact/hooks";
import type { Turn } from "../api";

type Renderer = typeof import("../markdown").renderMarkdown;

// The renderer is loaded when first needed, so pages that never show a reply don't pay for it.
let renderer: Renderer | null = null;

function useRenderer(): Renderer | null {
  const [loaded, setLoaded] = useState(() => renderer);
  useEffect(() => {
    if (loaded !== null) return;
    import("../markdown")
      .then((module) => {
        renderer = module.renderMarkdown;
        setLoaded(() => module.renderMarkdown);
      })
      // Replies still show, as plain text.
      .catch((e: unknown) => console.error("Couldn't load the markdown renderer", e));
  }, [loaded]);
  return loaded;
}

/** A coach's reply, formatted. Links open in a new tab, so following one keeps Workshop open. */
function Reply({ text, writing = false }: { text: string; writing?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const render = useRenderer();
  const html = render === null ? null : render(text);
  useEffect(() => {
    for (const link of ref.current?.querySelectorAll("a[href]") ?? []) {
      link.setAttribute("target", "_blank");
      link.setAttribute("rel", "noopener noreferrer");
    }
  }, [html]);
  const classes = `turn coach ${writing ? "writing" : ""}`;
  if (html === null) return <div class={classes}>{text}</div>;
  // Rendered from markdown with raw HTML escaped and unsafe links dropped.
  return <div ref={ref} class={`${classes} markdown`} dangerouslySetInnerHTML={{ __html: html }} />;
}

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
        {turns.map((t, i) =>
          t.speaker === "coach" ? (
            <Reply key={i} text={t.text} />
          ) : (
            <div key={i} class="turn user">
              {t.text}
            </div>
          ),
        )}
        {thinking ? (
          partial ? (
            <Reply text={partial} writing />
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
