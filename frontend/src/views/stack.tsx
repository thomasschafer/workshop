import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useElapsed } from "../hooks/useElapsed";
import { useFlip } from "../hooks/useFlip";
import type { TalkPhase } from "../hooks/usePushToTalk";
import type { Card } from "../utterances";

interface Props {
  cards: Card[];
  /** What's being said, or was just said and is still arriving, oldest first. */
  live: { id: number; text: string; phase: TalkPhase; level: number | null }[];
  /** The card whose question is being answered, if any. */
  replyingTo: number | null;
  onDismiss: (id: number) => void;
  /** Does what an offer's button says. */
  onAct: (id: number) => void;
  onReply: (id: number) => void;
  onCancelReply: () => void;
  /** Called with the stack's height, so what's underneath can keep clear of it. */
  onHeight: (px: number) => void;
}

/** More than this many cards, and the middle ones fold into a count. */
const MAX_SHOWN = 4;

/**
 * Utterances as cards stacked above the controls: oldest at the top, leaving once done, and the
 * newest at the bottom, nearest the talk button, where what's being said appears as it's said.
 */
export function Stack({
  cards,
  live,
  replyingTo,
  onDismiss,
  onAct,
  onReply,
  onCancelReply,
  onHeight,
}: Props) {
  const ref = useRef<HTMLDivElement>(null);
  useFlip(ref);

  const latestHeight = useRef(onHeight);
  latestHeight.current = onHeight;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const observer = new ResizeObserver(() => latestHeight.current(element.offsetHeight));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const view = (card: Card) => (
    <CardView
      key={card.id}
      card={card}
      replying={replyingTo === card.id}
      onDismiss={() => onDismiss(card.id)}
      onAct={() => onAct(card.id)}
      onReply={() => onReply(card.id)}
      onCancelReply={onCancelReply}
    />
  );
  // The oldest, which is usually being worked on, then a count of those folded away, then the
  // newest.
  const folded = cards.length > MAX_SHOWN ? cards.length - (MAX_SHOWN - 1) : 0;
  const [oldest, ...rest] = cards;
  const shown =
    folded > 0 && oldest
      ? [
          view(oldest),
          <div key="folded" data-flip="folded" class="card folded">
            +{folded} more
          </div>,
          ...rest.slice(folded).map(view),
        ]
      : cards.map(view);

  return (
    <div class="stack" ref={ref} aria-live="polite">
      {shown}
      {live.map(({ id, text, phase, level }) => (
        <div key={id} data-flip={String(id)} class={`card live ${phase}`}>
          <div class="live-text">
            {/* Words said before the microphone is on are lost, so this says when to start. */}
            <span>{text || LIVE_PROMPT[phase]}</span>
          </div>
          {phase === "listening" && level !== null ? <LevelMeter level={level} /> : null}
        </div>
      ))}
    </div>
  );
}

/**
 * How loud the microphone hears it, so it's plain that it's hearing you: a row of bars that rise
 * with your voice.
 */
function LevelMeter({ level }: { level: number }) {
  // Speech is mostly quiet in absolute terms, so the scale favours the low end.
  const shown = Math.min(1, Math.sqrt(level) * 1.4);
  return (
    <div class="level-meter" aria-hidden="true">
      {METER_BARS.map((weight) => (
        <span key={weight} style={{ transform: `scaleY(${Math.max(0.12, shown * weight)})` }} />
      ))}
    </div>
  );
}

/** Each bar's share of the level: tallest in the middle. */
const METER_BARS = [0.55, 0.8, 1, 0.85, 0.6];

const LIVE_PROMPT: Record<TalkPhase, string> = {
  starting: "Starting the microphone…",
  listening: "Listening…",
  hearing: "Hearing…",
};

function CardView({
  card,
  replying,
  onDismiss,
  onAct,
  onReply,
  onCancelReply,
}: {
  card: Card;
  replying: boolean;
  onDismiss: () => void;
  onAct: () => void;
  onReply: () => void;
  onCancelReply: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  // Long transcripts are cut short; tapping one shows the whole of what was said.
  const transcript = (text: string) => (
    <button
      type="button"
      class="card-transcript"
      aria-expanded={expanded}
      onClick={() => setExpanded((x) => !x)}
    >
      “{text}”
    </button>
  );
  const { status } = card;
  const pill = status.kind === "waiting" || status.kind === "working";
  const tone =
    status.kind === "done"
      ? status.tone
      : status.kind === "problem"
        ? status.tone
        : status.kind === "asked"
          ? "warn"
          : "";

  return (
    <div
      data-flip={String(card.id)}
      class={`card ${status.kind} ${tone} ${card.leaving ? "leaving" : ""} ${expanded ? "expanded" : ""}`}
    >
      {/* Keyed by status, so a change of status fades in rather than jumping. */}
      <div key={status.kind} class="card-body">
        <span class="card-mark" aria-hidden="true">
          {status.kind === "working" ? (
            <span class="spinner" />
          ) : status.kind === "waiting" ? (
            "·"
          ) : status.kind === "done" ? (
            status.tone === "ok" ? (
              "✓"
            ) : (
              "i"
            )
          ) : status.kind === "asked" ? (
            "?"
          ) : status.kind === "offer" ? (
            "★"
          ) : (
            "!"
          )}
        </span>
        <div class="card-text">
          {pill ? (
            <>
              <span class="card-label">
                {status.kind === "working" ? (
                  <Working label={status.label} since={status.since} />
                ) : (
                  "Waiting"
                )}
              </span>
              {card.transcript ? transcript(card.transcript) : null}
            </>
          ) : (
            <>
              {card.transcript ? transcript(card.transcript) : null}
              <span class="card-result">
                {status.kind === "asked"
                  ? status.question
                  : status.kind === "done" || status.kind === "problem" || status.kind === "offer"
                    ? status.text
                    : null}
              </span>
              {status.kind === "offer" ? (
                <span class="card-actions">
                  <button type="button" class="pill primary small" onClick={onAct}>
                    {status.action}
                  </button>
                </span>
              ) : null}
              {status.kind === "asked" ? (
                <span class="card-actions">
                  {replying ? (
                    <>
                      <span class="muted">Hold the button to answer.</span>
                      <button type="button" class="text-button" onClick={onCancelReply}>
                        Cancel
                      </button>
                    </>
                  ) : (
                    <>
                      <button type="button" class="text-button" onClick={onReply}>
                        Reply
                      </button>
                      <span class="muted">or hold the button to start afresh</span>
                    </>
                  )}
                </span>
              ) : null}
            </>
          )}
        </div>
        {pill ? (
          <button type="button" class="card-cancel" onClick={onDismiss}>
            Cancel
          </button>
        ) : status.kind === "done" ? null : (
          <button type="button" class="card-dismiss" aria-label="Dismiss" onClick={onDismiss}>
            ✕
          </button>
        )}
      </div>
    </div>
  );
}

function Working({ label, since }: { label: string; since: number }) {
  const elapsed = useElapsed(since);
  return (
    <>
      {label} <span class="elapsed">· {(elapsed ?? 0).toFixed(1)}s</span>
    </>
  );
}
