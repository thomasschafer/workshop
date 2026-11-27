import { useEffect, useRef, useState } from "preact/hooks";
import { showCalls } from "../coding/steps";
import { errorMessage } from "../errors";
import { BriefView, MarkedView } from "../grading/marked";
import { useConnection } from "../hooks/useConnection";
import { newId } from "../learning/local";
import { Markdown } from "../learning/practice";
import { Loading, Page } from "../progress/page";
import { DictateButton } from "../views/dictate";
import { roundsApi } from "./api";
import { BEAT_MS, clockText, remainingAfter } from "./clock";
import "./rounds.css";
import type { Ended, Ending, Listed, Opened, Overview, Round, RoundKind } from "./types";

const KIND: Record<RoundKind, string> = {
  coding: "Coding problem",
  probability: "Probability",
  design: "Design prompt",
};

const WORKING_HINT: Record<RoundKind, string> = {
  coding: "Your approach, then code or steps close to it",
  probability: "How you're working it out, and your answer",
  design: "Requirements, components and trade-offs, as you go",
};

const ENDING: Record<Ending, string> = {
  time_up: "Time's up.",
  finished: "You ended the round.",
  interrupted:
    "This round ended while you were away, as over half an hour passed. It's marked on what you did, but doesn't count as an attempt.",
};

/** Timed rounds: the list of them, or one, as `pack/item`, under way or to start. */
export function RoundsScreen({
  item,
  serverDictation,
  onHome,
  onOpen,
}: {
  item: string | null;
  serverDictation: boolean;
  onHome: () => void;
  onOpen: (item: string | null) => void;
}) {
  if (item === null) return <RoundList onHome={onHome} onOpen={onOpen} />;
  return (
    <RoundItem
      key={item}
      itemKey={item}
      serverDictation={serverDictation}
      onHome={onHome}
      onList={() => onOpen(null)}
    />
  );
}

function RoundList({ onHome, onOpen }: { onHome: () => void; onOpen: (item: string) => void }) {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    setError(null);
    roundsApi.overview().then(setOverview, (e: unknown) => setError(errorMessage(e)));
  }, [attempt]);
  const link = (listed: Listed, summary: string) => (
    <li key={listed.key}>
      <button type="button" class="home-link" onClick={() => onOpen(listed.key)}>
        <span class="home-link-name">{listed.label}</span>
        <span class="home-link-summary">{summary}</span>
      </button>
    </li>
  );
  return (
    <Page title="Timed rounds" icon="timer" onHome={onHome}>
      {overview === null ? (
        <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
      ) : overview.items.length === 0 ? (
        <p class="empty">
          Your packs have no coding problems, probability questions or design prompts to make a
          round of.
        </p>
      ) : (
        <>
          <p class="muted">
            A round is a problem against the clock, with an examiner who asks follow-up questions as
            you go, then marks it when time's up. The clock only runs while the round is open here.
          </p>
          {overview.under_way.length > 0 ? (
            <section aria-labelledby="rounds-under-way">
              <h2 id="rounds-under-way" class="tracks-heading">
                Under way
              </h2>
              <ul class="design-list">
                {overview.under_way.map((listed) =>
                  link(
                    listed,
                    listed.ended
                      ? "Over, to be marked"
                      : `${clockText(listed.remaining_ms ?? 0)} left of ${listed.minutes} minutes`,
                  ),
                )}
              </ul>
            </section>
          ) : null}
          <section aria-labelledby="rounds-all">
            <h2 id="rounds-all" class="tracks-heading">
              Start a round
            </h2>
            <ul class="design-list">
              {overview.items.map((listed) =>
                link(
                  listed,
                  `${KIND[listed.kind]} · ${listed.minutes} minutes${
                    overview.suggested?.key === listed.key ? ` · ${overview.suggested.reason}` : ""
                  }`,
                ),
              )}
            </ul>
          </section>
        </>
      )}
    </Page>
  );
}

function RoundItem({
  itemKey,
  serverDictation,
  onHome,
  onList,
}: {
  itemKey: string;
  serverDictation: boolean;
  onHome: () => void;
  onList: () => void;
}) {
  const online = useConnection();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  const [style, setStyle] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    roundsApi.open(itemKey).then(
      (loaded) => {
        setOpened(loaded);
        setStyle((chosen) => chosen ?? loaded.styles[0]?.id ?? null);
      },
      (e: unknown) => setError(errorMessage(e)),
    );
  }, [attempt]);

  const start = () => {
    setStarting(true);
    setError(null);
    roundsApi
      .start(itemKey, style)
      .then(setOpened, (e: unknown) => setError(errorMessage(e)))
      .finally(() => setStarting(false));
  };

  if (opened === null) {
    return (
      <Page title="Timed rounds" icon="timer" onHome={onHome}>
        <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
      </Page>
    );
  }
  if (opened.round) {
    return (
      <Page title="Timed rounds" icon="timer" onHome={onHome}>
        <RoundView
          opened={opened}
          round={opened.round}
          serverDictation={serverDictation}
          onDone={onList}
        />
      </Page>
    );
  }
  return (
    <Page title="Timed rounds" icon="timer" onHome={onHome}>
      <h2 class="design-stage-name">{opened.label}</h2>
      <section class="design-intro" aria-label="Timed round">
        <p class="muted">
          A round of {opened.minutes} minutes on this {KIND[opened.kind].toLowerCase()}. The problem
          shows once the clock starts. Talk it through with the examiner as you work: it answers
          questions and asks follow-ups that extend or change the problem. When time's up, the
          grader marks your working and what was said. If you have to stop, the clock stops with
          you; after half an hour away, the round ends and is marked on what you did.
        </p>
        {opened.styles.length > 0 ? (
          <fieldset class="round-styles">
            <legend class="learn-question">The examiner's style</legend>
            {opened.styles.map((s) => (
              <label key={s.id} class="round-style">
                <input
                  type="radio"
                  name="round-style"
                  value={s.id}
                  checked={style === s.id}
                  onChange={() => setStyle(s.id)}
                />
                <span>
                  <span class="round-style-name">{s.name}</span>
                  <span class="muted round-style-description">{s.description}</span>
                </span>
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? (
          <p class="error-text" role="alert">
            {error}
          </p>
        ) : null}
        <span class="learn-actions">
          <button type="button" class="pill" onClick={onList}>
            Later
          </button>
          <button type="button" class="pill primary" disabled={starting || !online} onClick={start}>
            Start the clock
          </button>
        </span>
      </section>
    </Page>
  );
}

/** Working typed here that the server hasn't confirmed yet, such as while it can't be reached. */
const unsavedKey = (key: string) => `workshop:unsaved:round:${key}`;

function readUnsaved(key: string): string | null {
  try {
    return localStorage.getItem(unsavedKey(key));
  } catch {
    return null;
  }
}

function writeUnsaved(key: string, work: string | null): void {
  try {
    if (work === null) localStorage.removeItem(unsavedKey(key));
    else localStorage.setItem(unsavedKey(key), work);
  } catch {
    // Storage can be full or disabled; the working still goes with the next beat.
  }
}

/**
 * A round under way: the clock, the problem, the learner's working and the conversation with
 * the examiner. The app tells the server every few seconds that it's still open, with the
 * working, which is what runs the clock; when it runs out, or the learner ends it, the round
 * goes to the grader.
 */
export function RoundView({
  opened,
  round: initial,
  serverDictation,
  onDone,
}: {
  opened: Opened;
  round: Round;
  serverDictation: boolean;
  onDone: () => void;
}) {
  const key = opened.key;
  const online = useConnection();
  const [round, setRound] = useState(initial);
  // The clock as the server last said, and when that was here.
  const [clock, setClock] = useState({
    at: performance.now(),
    clock: initial.clock,
  });
  const [now, setNow] = useState(() => performance.now());
  const [ended, setEnded] = useState<Ending | null>(initial.ended);
  const [work, setWork] = useState(() => readUnsaved(key) ?? initial.work);
  const workRef = useRef(work);
  workRef.current = work;
  const [beatError, setBeatError] = useState<string | null>(null);
  const [say, setSay] = useState("");
  const [saying, setSaying] = useState(false);
  const [sayError, setSayError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [result, setResult] = useState<Ended | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  // The attempt the round records, kept for trying again if marking fails.
  const attemptId = useRef(newId());

  const heard = (next: { clock: Round["clock"]; ended: Ending | null }) => {
    setClock({ at: performance.now(), clock: next.clock });
    if (next.ended) setEnded(next.ended);
  };

  const beating = useRef(false);
  const beat = async (keepalive = false) => {
    if (beating.current && !keepalive) return;
    beating.current = true;
    const sent = workRef.current;
    try {
      heard(await roundsApi.beat(key, sent, keepalive));
      if (workRef.current === sent) writeUnsaved(key, null);
      setBeatError(null);
    } catch (e) {
      setBeatError(errorMessage(e));
    } finally {
      beating.current = false;
    }
  };

  useEffect(() => {
    if (ended) return;
    const timer = setInterval(() => {
      if (document.visibilityState === "visible") void beat();
    }, BEAT_MS);
    const tick = setInterval(() => setNow(performance.now()), 250);
    // Back in the app after the phone slept, or another app was in front: the server says how
    // the clock stands at once.
    const onVisible = () => {
      if (document.visibilityState === "visible") void beat();
    };
    const leave = () => void beat(true);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener("pagehide", leave);
    return () => {
      clearInterval(timer);
      clearInterval(tick);
      document.removeEventListener("visibilitychange", onVisible);
      window.removeEventListener("pagehide", leave);
    };
  }, [ended]);

  // Leaving the round, such as to pause it, takes the latest working to the server.
  const endedRef = useRef(ended);
  endedRef.current = ended;
  useEffect(
    () => () => {
      if (!endedRef.current) void beat(true);
    },
    [],
  );

  const remaining = ended ? 0 : remainingAfter(clock.clock, now - clock.at);
  // Out of time here: the server, whose clock it is, ends the round.
  useEffect(() => {
    if (!ended && remaining === 0) void beat();
  }, [remaining === 0, ended]);

  const end = async () => {
    setMarking(true);
    setMarkError(null);
    try {
      const marked = await roundsApi.end(key, attemptId.current, ended ? null : workRef.current);
      writeUnsaved(key, null);
      setEnded(marked.ending);
      setResult(marked);
    } catch (e) {
      setMarkError(errorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  // Once it's over, it's marked straight away.
  useEffect(() => {
    if (ended && !result && !marking && !markError) void end();
  }, [ended]);

  const talk = async () => {
    setSaying(true);
    setSayError(null);
    try {
      const reply = await roundsApi.say(key, say.trim(), workRef.current);
      if (!reply.round) throw new Error("The round has gone.");
      setRound(reply.round);
      heard(reply.round);
      setSay("");
    } catch (e) {
      setSayError(errorMessage(e));
      // Most likely the clock ran out: the server says.
      void beat();
    } finally {
      setSaying(false);
    }
  };

  if (result) {
    return (
      <>
        <h2 class="design-stage-name">{opened.label}</h2>
        <p role="status">{ENDING[result.ending]}</p>
        <MarkedView marked={result.marked} />
        {result.rubric.length > 0 ? (
          <details>
            <summary class="muted">The rubric</summary>
            <ul>
              {result.rubric.map((point) => (
                <li key={point}>{point}</li>
              ))}
            </ul>
          </details>
        ) : null}
        {result.brief ? <BriefView brief={result.brief} /> : null}
        <button type="button" class="pill primary wide" onClick={onDone}>
          Done
        </button>
      </>
    );
  }

  const low = remaining < 60_000;
  return (
    <>
      <div class={`round-bar${low ? " low" : ""}`}>
        <span class="round-title">{opened.label}</span>
        <span class="round-clock" role="timer" aria-label="Time left">
          {clockText(remaining)}
        </span>
      </div>
      {round.style ? <p class="muted round-with">Examiner: {round.style.name}</p> : null}
      {ended ? (
        <section class="design-intro" aria-label="Round over">
          <p role="status">{ENDING[ended]}</p>
          {markError ? (
            <>
              <p class="error-text" role="alert">
                {markError}
              </p>
              <button
                type="button"
                class="pill primary"
                disabled={marking || !online}
                onClick={() => void end()}
              >
                Mark it
              </button>
            </>
          ) : (
            <p class="muted">Marking…</p>
          )}
        </section>
      ) : (
        <>
          {round.returned ? (
            <p class="muted" role="status">
              Welcome back. The clock stopped while you were away, and carries on from where it was.
            </p>
          ) : null}
          {beatError ? (
            <p class="muted" role="status">
              Can't reach the server: {beatError}. The clock stops until it can, and your working is
              kept on this device.
            </p>
          ) : null}
        </>
      )}
      <details class="coding-statement" open>
        <summary>The problem</summary>
        <Markdown text={opened.prompt} class="learn-prompt" />
        {opened.examples.map((example, at) => (
          // The examples are fixed for the item, in order.
          <div key={at} class="round-example">
            <span class="muted">Example {at + 1}</span>
            {opened.api ? (
              <pre>{showCalls(opened.api, example.input, example.output)}</pre>
            ) : (
              <>
                <pre>{example.input}</pre>
                <pre>{example.output}</pre>
              </>
            )}
          </div>
        ))}
        {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
      </details>
      <section class="design-stage" aria-label="Working">
        <label class="learn-question" for="round-work">
          Your working
        </label>
        <textarea
          id="round-work"
          class="written"
          placeholder={WORKING_HINT[opened.kind]}
          value={work}
          readOnly={ended !== null}
          spellcheck={opened.kind !== "coding"}
          onInput={(event) => {
            const text = event.currentTarget.value;
            setWork(text);
            writeUnsaved(key, text);
          }}
        />
        {ended ? null : (
          <DictateButton
            serverDictation={serverDictation}
            onHeard={(text) => {
              const next = work.trim() ? `${work.replace(/\s*$/, "")}\n${text}` : text;
              setWork(next);
              writeUnsaved(key, next);
            }}
            onNotice={setNotice}
          />
        )}
      </section>
      <section class="design-coach" aria-label="Examiner">
        <h3 class="tracks-heading">Examiner</h3>
        {round.turns.length === 0 ? (
          <p class="muted">
            Ask about anything that's unclear, and say what you're thinking as you go. Once you have
            an answer, tell the examiner, who will follow up.
          </p>
        ) : (
          <ol class="design-turns">
            {round.turns.map((turn) => (
              <li key={`${turn.at}-${turn.speaker}`} class={`design-turn ${turn.speaker}`}>
                {turn.text}
              </li>
            ))}
          </ol>
        )}
        {ended ? null : (
          <>
            <label class="muted" for="round-say">
              Say to the examiner
            </label>
            <textarea
              id="round-say"
              class="written design-reply"
              value={say}
              readOnly={saying}
              onInput={(event) => setSay(event.currentTarget.value)}
            />
            <DictateButton
              serverDictation={serverDictation}
              onHeard={(text) =>
                setSay((sofar) => (sofar.trim() ? `${sofar.trimEnd()} ${text}` : text))
              }
              onNotice={setNotice}
            />
            {sayError ? (
              <p class="error-text" role="alert">
                {sayError}
              </p>
            ) : null}
            <button
              type="button"
              class="pill"
              disabled={saying || !online || !say.trim()}
              onClick={() => void talk()}
            >
              {saying ? "The examiner is thinking…" : "Say it"}
            </button>
          </>
        )}
        {notice ? <p class="muted">{notice}</p> : null}
      </section>
      {ended ? null : (
        <>
          {markError ? (
            <p class="error-text" role="alert">
              {markError}
            </p>
          ) : null}
          <span class="learn-actions">
            <button type="button" class="pill" onClick={onDone}>
              Pause
            </button>
            <button
              type="button"
              class="pill primary"
              disabled={marking || !online}
              onClick={() => void end()}
            >
              {marking ? "Marking…" : "End and mark it"}
            </button>
          </span>
        </>
      )}
    </>
  );
}
