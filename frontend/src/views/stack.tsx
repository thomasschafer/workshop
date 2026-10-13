import { useLayoutEffect, useRef, useState } from "preact/hooks";
import { useElapsed } from "../hooks/useElapsed";
import { useFlip } from "../hooks/useFlip";
import type { Card } from "../utterances";

interface Props {
  cards: Card[];
  /** What's being said, or was just said and is still arriving, oldest first. */
  live: { id: number; text: string }[];
  /** The card whose question is being answered, if any. */
  replyingTo: number | null;
  onDismiss: (id: number) => void;
  onReply: (id: number) => void;
  onCancelReply: () => void;
  /** Called with the stack's height, so what's underneath can keep clear of it. */
  onHeight: (px: number) => void;
}

/** More than this many cards, and the middle ones fold into a count. */
const MAX_SHOWN = 4;
/** How far a card is swiped before letting go dismisses it. */
const SWIPE_PX = 80;

/**
 * Utterances as cards stacked above the controls: oldest at the top, leaving once done, and the
 * newest at the bottom, nearest the talk button, where what's being said appears as it's said.
 */
export function Stack({
  cards,
  live,
  replyingTo,
  onDismiss,
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
      {live.map(({ id, text }) => (
        <div key={id} data-flip={String(id)} class="card listening">
          <div class="live-text">
            <span>{text || "Listening…"}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function CardView({
  card,
  replying,
  onDismiss,
  onReply,
  onCancelReply,
}: {
  card: Card;
  replying: boolean;
  onDismiss: () => void;
  onReply: () => void;
  onCancelReply: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const swipe = useSwipe(onDismiss, () => setExpanded((e) => !e));
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
      style={swipe.style}
      {...swipe.handlers}
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
              {card.transcript ? <span class="card-transcript">“{card.transcript}”</span> : null}
            </>
          ) : (
            <>
              {card.transcript ? <span class="card-transcript">“{card.transcript}”</span> : null}
              <span class="card-result">
                {status.kind === "asked"
                  ? status.question
                  : status.kind === "done" || status.kind === "problem"
                    ? status.text
                    : null}
              </span>
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
        {status.kind === "done" ? null : (
          <button
            type="button"
            class="card-dismiss"
            aria-label={pill ? "Cancel" : "Dismiss"}
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
          >
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

/** Dragging a card sideways to dismiss it; a tap without dragging does `onTap`. */
function useSwipe(onDismiss: () => void, onTap: () => void) {
  const start = useRef<{ x: number; y: number; pointer: number } | null>(null);
  const [dx, setDx] = useState(0);
  return {
    style:
      dx === 0
        ? undefined
        : { transform: `translateX(${dx}px)`, opacity: Math.max(0.2, 1 - Math.abs(dx) / 200) },
    handlers: {
      onPointerDown: (e: PointerEvent) => {
        if ((e.target as HTMLElement).closest("button")) return;
        start.current = { x: e.clientX, y: e.clientY, pointer: e.pointerId };
      },
      onPointerMove: (e: PointerEvent) => {
        const from = start.current;
        if (!from || from.pointer !== e.pointerId) return;
        const moved = e.clientX - from.x;
        // Mostly sideways: a vertical drag is someone scrolling.
        if (Math.abs(moved) > 8 && Math.abs(moved) > Math.abs(e.clientY - from.y)) {
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
          setDx(moved);
        }
      },
      onPointerUp: () => {
        if (!start.current) return;
        start.current = null;
        if (Math.abs(dx) > SWIPE_PX) {
          // Stays where it was swiped to while it fades away.
          onDismiss();
          return;
        }
        if (Math.abs(dx) < 4) onTap();
        setDx(0);
      },
      onPointerCancel: () => {
        start.current = null;
        setDx(0);
      },
    },
  };
}
