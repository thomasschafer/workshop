import { useRef, useState } from "preact/hooks";
import { ApiError } from "../api";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { learning } from "../learning/sync";
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
 * on the server once it's given, naming the question it answers, so it's safe to send again
 * after a lost reply, and the app can be closed at any point and carried on.
 */
export function FollowUpsView({
  itemKey,
  exchange: initial,
  error: initialError = null,
  about = null,
  serverDictation,
  onMarked,
  onShowAnswer,
  onOver,
}: {
  itemKey: string;
  exchange: Exchange;
  /** Why the tutor couldn't ask its question, if it couldn't. */
  error?: string | null;
  /** Something to say about these follow-ups, such as that they were started before. */
  about?: string | null;
  serverDictation: boolean;
  /** Once the grader's marked the whole exchange, which is the card's attempt. */
  onMarked: (reply: MarkedReply, exchange: Exchange) => void;
  /** Leaves the questions, to see the answer and rate the card as usual. */
  onShowAnswer: () => void;
  /** Once the server says they're over, as the card was answered another way, saying why. */
  onOver: (why: string) => void;
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
    if (question !== null) {
      writeDraft(localStorage, itemKey, { exchange: exchange.id, question, text, mode });
    }
  };
  const setText = (update: string | ((sofar: string) => string)) =>
    keep(typeof update === "function" ? update(kept.current.text) : update, kept.current.mode);
  const setMode = (mode: Mode) => keep(kept.current.text, mode);
  const forgetDraft = () => {
    kept.current = { ...kept.current, text: "" };
    setTextState("");
    writeDraft(localStorage, itemKey, null);
  };

  /**
   * After a request fails, where things stand on the server: the same follow-ups, with the
   * reply to `answering` kept or not, or none, if they're over.
   */
  const recover = async (e: unknown, answering: number | null) => {
    if (e instanceof ApiError && e.status === 409) {
      forgetDraft();
      onOver(e.message);
      return;
    }
    setError(errorMessage(e));
    const saved = await gradingApi.followUps(itemKey).catch(() => undefined);
    if (saved === undefined) return;
    if (saved === null || saved.id !== exchange.id) {
      forgetDraft();
      onOver("These follow-up questions are over, as the card's been answered another way since.");
      return;
    }
    setExchange(saved);
    if (answering !== null && replied(saved, answering)) forgetDraft();
  };

  /**
   * Sends the reply to the question waiting, and has the tutor ask its next, unless `ask`,
   * giving the follow-ups as they then are, or null if it couldn't.
   */
  const send = async (said: string, ask = true): Promise<Exchange | null> => {
    if (question === null) throw new Error("there's no question waiting for a reply");
    setSending(true);
    setError(null);
    try {
      const next = await gradingApi.replyToFollowUp(
        itemKey,
        exchange.id,
        question,
        said,
        mode === "aloud",
        ask,
      );
      setExchange(next);
      forgetDraft();
      if (next.next === "reply" && mode === "writing") reply.current?.focus();
      return next;
    } catch (e) {
      await recover(e, question);
      return null;
    } finally {
      setSending(false);
    }
  };

  const askAgain = async () => {
    setSending(true);
    setError(null);
    try {
      setExchange(await gradingApi.askFollowUp(itemKey, exchange.id));
    } catch (e) {
      await recover(e, null);
    } finally {
      setSending(false);
    }
  };

  /** Has it marked, sending first any reply written but not sent, so it isn't lost. */
  const finish = async () => {
    let latest = exchange;
    if (question !== null && kept.current.text.trim()) {
      const sent = await send(kept.current.text, false);
      if (!sent) return;
      latest = sent;
    }
    setMarking(true);
    setError(null);
    try {
      const marked = await gradingApi.finishFollowUps(itemKey, exchange.id);
      forgetDraft();
      learning().forgetFollowUps(itemKey);
      // So the attempt is on this device too, rather than offering the card again first.
      void learning().sync();
      onMarked(marked, latest);
    } catch (e) {
      // Marking it again gives the marks already given, so it's left to be tried again, unless
      // the server says it's over.
      if (e instanceof ApiError && e.status === 409) {
        forgetDraft();
        onOver(e.message);
      } else {
        setError(errorMessage(e));
      }
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
      {about ? (
        <p class="muted" role="status">
          {about}
        </p>
      ) : null}
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
              disabled={busy}
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
              busy={busy}
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
            onClick={() => void askAgain()}
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
            {marking ? "Marking…" : text.trim() ? "Send it and mark it now" : "Mark it now"}
          </button>
        ) : null}
        <button
          type="button"
          class="learn-link"
          disabled={busy}
          onClick={() => {
            forgetDraft();
            onShowAnswer();
          }}
        >
          Show answer and rate it myself
        </button>
      </span>
    </section>
  );
}
