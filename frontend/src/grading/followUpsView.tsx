import { useRef, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { newId } from "../learning/local";
import { DictateButton } from "../views/dictate";
import { gradingApi } from "./api";
import { AloudInput } from "./explain";
import { type Mode, modeOf, readDraft, replied, turnsOf, waiting, writeDraft } from "./followUps";
import type { Exchange, MarkedReply } from "./types";

/** What's been said in an exchange, the learner's answers set in from the tutor's questions. */
export function FollowUpTurns({ exchange }: { exchange: Exchange }) {
  return (
    <ol class="design-turns">
      {turnsOf(exchange).map((turn, at) => (
        // A turn is its place in the exchange, which only ever grows at the end.
        <li key={at} class={`design-turn ${turn.who === "tutor" ? "coach" : "learner"}`}>
          {turn.text}
          {turn.spoken ? <span class="muted follow-ups-aloud"> (aloud)</span> : null}
        </li>
      ))}
    </ol>
  );
}

/**
 * A card being followed up: the tutor's questions about the learner's answer, each replied to
 * as the answer was, written or aloud, and switched between as they like, until it's asked them
 * all and the grader marks the lot. Each reply is kept on the device as it's written and saved
 * on the server once it's given, so the app can be closed at any point and carried on.
 */
export function FollowUpsView({
  itemKey,
  exchange: initial,
  error: initialError = null,
  serverDictation,
  onMarked,
  onShowAnswer,
}: {
  itemKey: string;
  exchange: Exchange;
  /** Why the tutor couldn't ask its question, if it couldn't. */
  error?: string | null;
  serverDictation: boolean;
  /** Once the grader's marked the whole exchange, which is the card's attempt. */
  onMarked: (reply: MarkedReply, exchange: Exchange) => void;
  /** Leaves the questions, to see the answer and rate the card as usual. */
  onShowAnswer: () => void;
}) {
  const online = useConnection();
  const [exchange, setExchange] = useState(initial);
  const [draft] = useState(() => readDraft(localStorage, itemKey, initial));
  const [mode, setModeState] = useState<Mode>(draft?.mode ?? modeOf(initial));
  const [text, setTextState] = useState(draft?.text ?? "");
  // As last changed, for changes that build on it before it's rendered.
  const kept = useRef({ text: draft?.text ?? "", mode: draft?.mode ?? modeOf(initial) });
  const [notice, setNotice] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(initialError);
  const reply = useRef<HTMLTextAreaElement>(null);
  const question = waiting(exchange);
  const busy = sending || marking;

  // Kept on the device as soon as it's written, for the question it replies to, so closing
  // the app at any moment keeps it.
  const keep = (text: string, mode: Mode) => {
    kept.current = { text, mode };
    setTextState(text);
    setModeState(mode);
    if (question !== null) writeDraft(localStorage, itemKey, { question, text, mode });
  };
  const setText = (update: string | ((sofar: string) => string)) =>
    keep(typeof update === "function" ? update(kept.current.text) : update, kept.current.mode);
  const setMode = (mode: Mode) => keep(kept.current.text, mode);

  const send = async (said: string | null) => {
    const answering = question;
    setSending(true);
    setError(null);
    try {
      const next = await gradingApi.answerFollowUp(itemKey, said, mode === "aloud");
      setExchange(next);
      setText("");
      writeDraft(localStorage, itemKey, null);
      if (next.next === "reply" && mode === "writing") reply.current?.focus();
    } catch (e) {
      setError(errorMessage(e));
      // The reply may have been kept even though the tutor couldn't ask its next question.
      const saved = await gradingApi.followUps(itemKey).catch(() => null);
      if (saved) {
        setExchange(saved);
        if (answering !== null && replied(saved, answering)) {
          setText("");
          writeDraft(localStorage, itemKey, null);
        }
      }
    } finally {
      setSending(false);
    }
  };

  const finish = async () => {
    setMarking(true);
    setError(null);
    try {
      const marked = await gradingApi.finishFollowUps(itemKey, newId());
      writeDraft(localStorage, itemKey, null);
      onMarked(marked, exchange);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  const asked = exchange.questions.length;
  const left = exchange.limit - asked;
  return (
    <section class="follow-ups" aria-label="Follow-up questions">
      <h3 class="tracks-heading">
        {asked === 0 ? "Follow-up questions" : `Follow-up question ${asked} of ${exchange.limit}`}
      </h3>
      <FollowUpTurns exchange={exchange} />
      {question !== null ? (
        mode === "writing" ? (
          <form
            class="learn-form"
            onSubmit={(event) => {
              event.preventDefault();
              void send(text);
            }}
          >
            <label class="learn-question muted" for="follow-up-reply">
              Your answer
            </label>
            <textarea
              id="follow-up-reply"
              ref={reply}
              class="written design-reply"
              rows={3}
              value={text}
              readOnly={busy}
              onInput={(event) => setText(event.currentTarget.value)}
            />
            <span class="learn-actions">
              {/* Only before anything's typed, as what's typed wasn't heard. */}
              <button
                type="button"
                class="pill"
                disabled={busy || text.trim() !== ""}
                onClick={() => setMode("aloud")}
              >
                Say it aloud
              </button>
              <button type="submit" class="pill primary" disabled={busy || !online || !text.trim()}>
                {sending ? (left > 0 ? "Asking…" : "Saving…") : "Answer"}
              </button>
            </span>
            <DictateButton
              serverDictation={serverDictation}
              onHeard={(heard) =>
                setText((sofar) => (sofar.trim() ? `${sofar.trimEnd()} ${heard}` : heard))
              }
              onNotice={setNotice}
            />
            {notice ? <p class="muted">{notice}</p> : null}
          </form>
        ) : (
          <section class="explain" aria-label="Explain it aloud">
            <p class="muted explain-hint">
              Talk it through. What you say aloud is marked for how clearly you put it too.
            </p>
            <AloudInput
              heard={text}
              setHeard={setText}
              readOnly={busy}
              serverDictation={serverDictation}
            />
            <span class="learn-actions">
              <button
                type="button"
                class="pill"
                disabled={busy}
                onClick={() => (text ? setText("") : setMode("writing"))}
              >
                {text ? "Start again" : "Type it"}
              </button>
              <button
                type="button"
                class="pill primary"
                disabled={busy || !online || !text.trim()}
                onClick={() => void send(text)}
              >
                {sending ? (left > 0 ? "Asking…" : "Saving…") : "Answer"}
              </button>
            </span>
          </section>
        )
      ) : exchange.next === "ask" ? (
        <>
          <p class="muted" role="status">
            {sending ? "The tutor is thinking of a question…" : "The tutor hasn't asked yet."}
          </p>
          <button
            type="button"
            class="pill primary wide"
            disabled={busy || !online}
            onClick={() => void send(null)}
          >
            {sending ? "Asking…" : "Ask the tutor"}
          </button>
        </>
      ) : (
        <>
          <p class="muted">That's all its questions. Mark them to see how deep you went.</p>
          <button
            type="button"
            class="pill primary wide"
            disabled={busy || !online}
            onClick={() => void finish()}
          >
            {marking ? "Marking…" : "Mark my answers"}
          </button>
        </>
      )}
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      {online ? null : (
        <p class="muted">
          Follow-up questions need the server. What you've said is kept, so carry on once it can be
          reached.
        </p>
      )}
      <span class="learn-links">
        {exchange.next !== "mark" && asked > 0 ? (
          <button
            type="button"
            class="learn-link"
            disabled={busy || !online}
            onClick={() => void finish()}
          >
            {marking ? "Marking…" : "Mark it now"}
          </button>
        ) : null}
        <button type="button" class="learn-link" disabled={busy} onClick={onShowAnswer}>
          Show answer and rate it myself
        </button>
      </span>
    </section>
  );
}
