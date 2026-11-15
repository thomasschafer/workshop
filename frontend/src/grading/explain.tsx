import { useState } from "preact/hooks";
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
}) {
  const online = useConnection();
  const { dictationMethod } = useDictation(serverDictation);
  const [heard, setHeard] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [marked, setMarked] = useState<MarkedReply | null>(null);
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
  if (marked) return <MarkedView marked={marked.marked} />;
  // Only the keyboard's microphone can hear on this device, so it types what's heard here.
  const byKeyboard = dictationMethod === "keyboard";
  return (
    <section class="explain" aria-label="Explain it aloud">
      <p class="learn-question">{question}</p>
      <p class="muted explain-hint">
        Talk it through as you would to someone listening. You're marked on whether it's right and
        how clearly you put it.
      </p>
      <DictateButton
        serverDictation={serverDictation}
        label="Hold to explain"
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
          readOnly={marking}
          onInput={(event) => setHeard(event.currentTarget.value)}
        />
      ) : heard ? (
        <blockquote class="explain-heard" aria-label="What you said">
          {heard}
        </blockquote>
      ) : null}
      {error ? (
        <p class="error-text" role="alert">
          {error}
        </p>
      ) : null}
      <span class="learn-actions">
        <button
          type="button"
          class="pill"
          disabled={marking || !heard}
          onClick={() => setHeard("")}
        >
          Start again
        </button>
        <button
          type="button"
          class="pill primary"
          disabled={marking || !heard.trim() || !online}
          onClick={mark}
        >
          {marking ? "Marking…" : "Mark my explanation"}
        </button>
      </span>
      {online ? null : <p class="muted">Marking it needs the server.</p>}
    </section>
  );
}
