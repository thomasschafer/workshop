import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { useDictation } from "../hooks/useDictation";
import { newId } from "../learning/local";
import { DictateButton } from "../views/dictate";
import { gradingApi } from "./api";
import { MarkedView } from "./marked";
import type { MarkedReply, Work } from "./types";

/**
 * Explaining an answer or an approach aloud, rather than writing it: hold the button and talk
 * it through, as many times as it takes, then have the grader mark what was heard, for whether
 * it's right and how clearly it was put. What it finds goes in the mistake log, and an answer
 * that counts as an attempt is recorded, as a written one is.
 */
export function ExplainAloud({
  itemKey,
  work,
  question,
  serverDictation,
  onMarked,
  mark: markWith,
  onDeeper,
  onBusy,
}: {
  itemKey: string;
  work: Work;
  /** Marks what was heard some other way than as `work`, such as an answer to a twist. */
  mark?: (heard: string) => Promise<MarkedReply>;
  /** What to explain, such as "How would you solve it?". */
  question: string;
  serverDictation: boolean;
  /** Once it's been marked, with what was heard. */
  onMarked: (reply: MarkedReply, heard: string) => void;
  /** Goes deeper instead of having it marked now, with follow-up questions on what was heard. */
  onDeeper?: (heard: string) => Promise<void>;
  /** Whenever it starts or stops marking or going deeper, so nothing else is done meanwhile. */
  onBusy?: (busy: boolean) => void;
}) {
  const online = useConnection();
  const [heard, setHeard] = useState("");
  const [marking, setMarking] = useState(false);
  const [deepening, setDeepening] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState<MarkedReply | null>(null);
  const busy = marking || deepening;
  useEffect(() => onBusy?.(busy), [busy]);
  const mark = () => {
    setMarking(true);
    setError(null);
    (markWith ? markWith(heard) : gradingApi.mark(itemKey, newId(), work, heard, true))
      .then(
        (reply) => {
          setMarked(reply);
          onMarked(reply, heard);
        },
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => setMarking(false));
  };
  const deeper = (go: (heard: string) => Promise<void>) => {
    setDeepening(true);
    setError(null);
    go(heard)
      .catch((e: unknown) => setError(errorMessage(e)))
      .finally(() => setDeepening(false));
  };
  if (marked) return <MarkedView marked={marked.marked} />;
  return (
    <section class="explain" aria-label="Explain it aloud">
      <p class="learn-question">{question}</p>
      <p class="muted explain-hint">
        Talk it through as you would to someone listening. You're marked on whether it's right and
        how clearly you put it.
      </p>
      <AloudInput heard={heard} setHeard={setHeard} busy={busy} serverDictation={serverDictation} />
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <span class="learn-actions">
        <button type="button" class="pill" disabled={busy || !heard} onClick={() => setHeard("")}>
          Start again
        </button>
        {onDeeper ? (
          <button
            type="button"
            class="pill"
            disabled={busy || !heard.trim() || !online}
            onClick={() => deeper(onDeeper)}
          >
            {deepening ? "Asking…" : "Go deeper"}
          </button>
        ) : null}
        <button
          type="button"
          class="pill primary"
          disabled={busy || !heard.trim() || !online}
          onClick={mark}
        >
          {marking ? "Marking…" : "Mark my explanation"}
        </button>
      </span>
      {online ? null : (
        <p class="muted">
          {onDeeper
            ? "Marking it, and going deeper, need the server."
            : "Marking it needs the server."}
        </p>
      )}
    </section>
  );
}

/**
 * Saying something aloud: hold the button and talk, as many times as it takes, each time adding
 * to what was heard, which is shown as it's said. Where only the keyboard's microphone can hear,
 * it types what's heard into a box here instead.
 */
export function AloudInput({
  heard,
  setHeard,
  busy,
  serverDictation,
}: {
  heard: string;
  setHeard: (update: (sofar: string) => string) => void;
  /** While what's been heard is being sent, so nothing more's added to it. */
  busy: boolean;
  serverDictation: boolean;
}) {
  const { dictationMethod } = useDictation(serverDictation);
  const [notice, setNotice] = useState<string | null>(null);
  // Only the keyboard's microphone can hear on this device, so it types what's heard here.
  const byKeyboard = dictationMethod === "keyboard";
  return (
    <>
      <DictateButton
        serverDictation={serverDictation}
        label="Hold to explain"
        disabled={busy}
        onHeard={(text) => {
          setNotice(null);
          setHeard((sofar) => (sofar.trim() ? `${sofar.trimEnd()} ${text}` : text));
        }}
        onNotice={setNotice}
      />
      {notice ? <p class="muted">{notice}</p> : null}
      {byKeyboard ? (
        <textarea
          class="written explain-heard"
          aria-label="What you said"
          value={heard}
          readOnly={busy}
          onInput={(event) => {
            const text = event.currentTarget.value;
            setHeard(() => text);
          }}
        />
      ) : heard ? (
        <blockquote class="explain-heard" aria-label="What you said">
          {heard}
        </blockquote>
      ) : null}
    </>
  );
}
