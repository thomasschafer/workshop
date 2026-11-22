import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { ConnectionError, connection } from "../api";
import { codingApi } from "../coding/api";
import { CodingItems, toDo } from "../coding/screen";
import type { Overview } from "../coding/types";
import { errorMessage } from "../errors";
import { gradingApi } from "../grading/api";
import { ExplainAloud } from "../grading/explain";
import { FollowUpsView, FollowUpTurns } from "../grading/followUpsView";
import { MarkedView } from "../grading/marked";
import type { Exchange, Marked } from "../grading/types";
import { useConnection } from "../hooks/useConnection";
import { useMarkdown } from "../hooks/useMarkdown";
import { HomeButton, TrackTitle } from "../progress/page";
import type { TrackId } from "../tracks/types";
import { describeTolerance, displayApproximate, displayNumber, grade } from "./grading";
import { limitsOf, newId, nextInstance, progress, queue, retired, step, utcOffset } from "./local";
import { sameOutput } from "./output";
import "./practice.css";
import { RetiredList } from "./retired";
import { learning, type SyncStatus } from "./sync";
import type { Attempt, Deck, DeckItem, Instance, Rating } from "./types";

/** Re-renders whenever the device's learning changes, such as after a sync. */
export function useLearning() {
  const [, setVersion] = useState(0);
  useEffect(() => learning().subscribe(() => setVersion((v) => v + 1)), []);
  return learning();
}

/** Formatted Markdown from a pack, with raw HTML escaped and unsafe links dropped. */
export function Markdown({ text, class: className = "" }: { text: string; class?: string }) {
  const render = useMarkdown();
  if (render === null) return <div class={`learn-text ${className}`}>{text}</div>;
  return (
    <div
      class={`learn-text markdown ${className}`}
      dangerouslySetInnerHTML={{ __html: render(text) }}
    />
  );
}

/** One result in a step: whether it was right, or null for a card marked by the learner. */
type Result = { key: string; right: boolean | null };

/**
 * Practising a track: a few minutes of its items at a time, due reviews first. Every answer is
 * saved on the device as it's given and synced when the server can be reached, so it can be
 * left at any moment, and works offline.
 */
export function Practice({
  track,
  serverDictation,
  onHome,
  onOpenProblem,
}: {
  track: TrackId;
  /** Whether Whisper is ready on the server, for explaining answers aloud. */
  serverDictation: boolean;
  onHome: () => void;
  /** Opens one of the track's coding problems, by its key. */
  onOpenProblem: (item: string) => void;
}) {
  const state = useLearning();
  const deck = state.deck;
  const [chosen, setChosen] = useState<string[] | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  // The deck's ready once it's been fetched, or right away if the device has one.
  const [tried, setTried] = useState(false);

  useEffect(() => {
    void state.sync().finally(() => setTried(true));
  }, []);

  const startStep = () => {
    if (!deck) return;
    const next = queue(
      deck,
      track,
      state.attempts,
      state.flagChanges,
      state.retirementChanges,
      Date.now(),
      utcOffset(),
    );
    setChosen(step(next).map((item) => item.key));
    setResults([]);
  };
  // The first step starts once there's a deck, from the device or the server.
  useEffect(() => {
    if (deck && chosen === null) startStep();
  }, [deck !== null]);
  // A step started from the device's deck, before it synced, is started again if the server
  // says a card has follow-up questions under way that it doesn't start with, such as ones
  // started on another device, unless anything in it's been done.
  useEffect(() => {
    if (!tried || !deck || chosen === null || results.length > 0) return;
    const underWay = queue(
      deck,
      track,
      state.attempts,
      state.flagChanges,
      state.retirementChanges,
      Date.now(),
      utcOffset(),
    ).followUps;
    if (underWay.some((item, at) => chosen[at] !== item.key)) startStep();
  }, [tried]);

  const name = deck?.tracks.find((t) => t.id === track)?.name ?? "Practice";
  const header = (
    <header class="top">
      <span class="header-start">
        <HomeButton onHome={onHome} />
        <TrackTitle title={name} icon={deck?.tracks.find((t) => t.id === track)?.icon} />
      </span>
      <SyncChip status={state.syncStatus} />
    </header>
  );

  if (!deck) {
    return (
      <div class="learn">
        {header}
        <main class="learn-content">
          {tried ? (
            <p class="error-text">
              {state.syncStatus.error ??
                "Practising offline needs this device to have been connected once, to fetch what to practise."}
            </p>
          ) : (
            <p class="muted">Loading…</p>
          )}
        </main>
      </div>
    );
  }

  if (chosen === null) return <div class="learn">{header}</div>;

  const items = chosen.flatMap((key) => deck.items.find((item) => item.key === key) ?? []);
  const current = items[results.length];
  return (
    <div class="learn">
      {header}
      {state.syncStatus.error ? (
        <div class="banner" role="alert">
          Couldn't sync: {state.syncStatus.error}. Your answers are kept on this device.
        </div>
      ) : null}
      <main class="learn-content">
        {current ? (
          <>
            <p class="learn-count muted">
              {results.length + 1} of {items.length}
            </p>
            <ItemView
              key={`${current.key}-${results.length}`}
              item={current}
              followedUp={deck.follow_ups?.includes(current.key) ?? false}
              serverDictation={serverDictation}
              onDone={(right) => setResults((done) => [...done, { key: current.key, right }])}
            />
          </>
        ) : (
          <>
            <Done deck={deck} track={track} results={results} onAgain={startStep} onHome={onHome} />
            <TrackProblems track={track} onOpen={onOpenProblem} />
          </>
        )}
      </main>
    </div>
  );
}

export function SyncChip({ status }: { status: SyncStatus }) {
  if (status.offline) {
    return (
      <span class="learn-sync offline" role="status">
        Offline{status.pending > 0 ? ` · ${status.pending} to sync` : ""}
      </span>
    );
  }
  if (status.pending > 0 || status.syncing) {
    return (
      <span class="learn-sync" role="status">
        Syncing…
      </span>
    );
  }
  return (
    <span class="learn-sync saved" role="status">
      Saved
    </span>
  );
}

/** One item, until it's answered or marked, and what to do next. */
export function ItemView({
  item,
  followedUp = false,
  serverDictation,
  onDone,
}: {
  item: DeckItem;
  /** Whether it's a card with follow-up questions under way, to carry on with. */
  followedUp?: boolean;
  serverDictation: boolean;
  onDone: (right: boolean | null) => void;
}) {
  const shown = useRef(Date.now());
  const attempt = (rating: Rating, extra: { response?: string; seed?: number }): Attempt => ({
    id: newId(),
    item: item.key,
    answered_at: Date.now(),
    duration_ms: Date.now() - shown.current,
    rating,
    ...extra,
  });
  const record = (rating: Rating, extra: { response?: string; seed?: number } = {}) => {
    learning().record(attempt(rating, extra));
  };
  // A right answer to an item with a fixed answer waits for the learner to say whether to
  // retire it. Left without saying, such as by going home or closing the app, it's "Got it".
  const choosing = useRef<Attempt | null>(null);
  useEffect(() => {
    const gotIt = () => {
      if (choosing.current) learning().record(choosing.current);
      choosing.current = null;
    };
    window.addEventListener("pagehide", gotIt);
    return () => {
      window.removeEventListener("pagehide", gotIt);
      gotIt();
    };
  }, []);
  /** Records an answer to an item with a fixed answer, which, right, waits for `choose`. */
  const answerFixed = (response: string | null, right: boolean) => {
    const extra = response === null ? {} : { response };
    if (right) choosing.current = attempt("easy", extra);
    else record("again", extra);
  };
  const choose = (choice: Choice) => {
    const chosen = choosing.current;
    choosing.current = null;
    if (chosen && choice === "retire") learning().retire(chosen);
    else if (chosen) learning().record(chosen);
    onDone(true);
  };
  return (
    <article class="learn-item">
      {item.kind === "card" ? (
        <CardView
          item={item}
          followedUp={followedUp}
          serverDictation={serverDictation}
          onRate={(rating) => {
            record(rating);
            onDone(null);
          }}
          onMarked={() => {
            // The grader's attempt is the server's, so the deck catches up with it.
            void learning().sync();
            onDone(null);
          }}
          onFlag={(note) => {
            learning().flag({
              id: newId(),
              item: item.key,
              at: Date.now(),
              flagged: true,
              ...(note ? { note } : {}),
            });
            onDone(null);
          }}
        />
      ) : item.kind === "reading" ? (
        <ReadingView item={item} onAnswer={answerFixed} onNext={onDone} onChoose={choose} />
      ) : item.kind === "mental-maths" ? (
        <TypedAnswer
          prompt={nextInstance(item.instances, learning().attempts, item.key)}
          tolerance={item.tolerance}
          estimate={describeTolerance(item.tolerance)}
          numbersOnly={item.instances.every((instance) => instance.answer >= 0)}
          onAnswer={(instance, response, right) => {
            record(right ? "good" : "again", {
              ...(response === null ? {} : { response }),
              seed: instance.seed,
            });
          }}
          onNext={onDone}
        />
      ) : (
        <TypedAnswer
          prompt={{
            seed: 0,
            prompt: item.prompt,
            answer: item.answer,
            method: item.solution,
          }}
          tolerance={item.tolerance}
          markdown
          onAnswer={(_, response, right) => answerFixed(response, right)}
          onNext={onDone}
          onChoose={choose}
        />
      )}
      {item.source ? <p class="learn-source muted">Source: {item.source}</p> : null}
    </article>
  );
}

function CardView({
  item,
  followedUp,
  serverDictation,
  onRate,
  onMarked,
  onFlag,
}: {
  item: Extract<DeckItem, { kind: "card" }>;
  /** Whether it has follow-up questions under way, to carry on with. */
  followedUp: boolean;
  serverDictation: boolean;
  onRate: (rating: Rating) => void;
  /** Once the grader has marked an answer in the learner's own words, which it records. */
  onMarked: () => void;
  onFlag: (note: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState("");
  /** Answering in the learner's own words, written or explained aloud, for the grader. */
  const [answering, setAnswering] = useState<"writing" | "aloud" | null>(null);
  const [written, setWritten] = useState("");
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Marked | null>(null);
  const online = useConnection();
  // A deck from an older Workshop doesn't say, so the server decides.
  const offersFollowUps = (item.follow_ups ?? 1) > 0;
  /** The follow-up questions under way, once the learner's gone deeper or come back to them. */
  const [exchange, setExchange] = useState<Exchange | null>(null);
  const [exchangeError, setExchangeError] = useState<string | null>(null);
  /** What to say about the follow-ups shown, or, once they're over, why. */
  const [exchangeAbout, setExchangeAbout] = useState<string | null>(null);
  const [overWhy, setOverWhy] = useState<string | null>(null);
  /** The exchange the grader marked, to show with its marks. */
  const [followedUpMarked, setFollowedUpMarked] = useState<Exchange | null>(null);
  const [deepening, setDeepening] = useState(false);
  const [aloudBusy, setAloudBusy] = useState(false);
  // The same each time going deeper is tried, so a start sent again finds the one started.
  const exchangeId = useRef(newId());
  const busy = marking || deepening || aloudBusy;

  /**
   * Carrying on with follow-ups under way: waiting to look for them until the server can be
   * reached, unless the learner's begun on the card another way, when going deeper finds them.
   */
  const [resume, setResume] = useState<"waiting" | "loading" | "failed" | "done">(
    followedUp ? "waiting" : "done",
  );
  const [resumeError, setResumeError] = useState<string | null>(null);
  const begun = answering !== null || revealed;
  const begunRef = useRef(begun);
  begunRef.current = begun;
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  // Heard of only once the deck's synced, such as for ones started on another device.
  useEffect(() => {
    if (followedUp && resume === "done" && !exchange && !begun) setResume("waiting");
  }, [followedUp]);
  useEffect(() => {
    if (resume !== "waiting" || !online) return;
    if (begun) {
      setResume("done");
      return;
    }
    setResume("loading");
    const look = async () => {
      // What was done on this device goes first, as it may have ended them.
      await learning().sync();
      // Lost again, it looks once the server's back.
      if (!connection.isOnline) return "waiting" as const;
      const status = learning().syncStatus;
      if (status.pending > 0) {
        throw new Error(status.error ?? "What was done here couldn't be sent first");
      }
      if (!learning().deck?.follow_ups?.includes(item.key)) return "done" as const;
      const kept = await gradingApi.followUps(item.key);
      // Left alone once the learner's begun another way, rather than taken from under them.
      if (kept && mounted.current && !begunRef.current) setExchange(kept);
      return "done" as const;
    };
    look().then(
      (next) => {
        if (mounted.current) setResume(next);
      },
      (e: unknown) => {
        if (!mounted.current) return;
        if (e instanceof ConnectionError) {
          setResume("waiting");
          return;
        }
        setResumeError(errorMessage(e));
        setResume("failed");
      },
    );
  }, [resume, online, begun]);
  const mark = () => {
    setMarking(true);
    setMarkError(null);
    gradingApi
      .mark(item.key, newId(), "card", written)
      .then(
        (reply) => {
          setMarked(reply.marked);
          setRevealed(true);
        },
        (e: unknown) => setMarkError(errorMessage(e)),
      )
      .finally(() => setMarking(false));
  };
  /** Starts the follow-up questions with the learner's answer, or finds those under way. */
  const goDeeper = async (answer: string, spoken: boolean) => {
    let started: Exchange;
    try {
      started = await gradingApi.startFollowUps(item.key, exchangeId.current, answer, spoken);
    } catch (e) {
      // The answer may have been kept even though the tutor couldn't ask its question.
      const kept = await gradingApi.followUps(item.key).catch(() => null);
      if (!kept) throw e;
      started = kept;
      setExchangeError(errorMessage(e));
    }
    setExchangeAbout(
      started.id === exchangeId.current
        ? null
        : "You'd started follow-up questions on this card already, so they carry on as they were.",
    );
    setOverWhy(null);
    setExchange(started);
    // So the deck on this device has it first, to carry on with after the app's closed.
    void learning().sync();
  };
  const goDeeperWritten = () => {
    setDeepening(true);
    setMarkError(null);
    goDeeper(written, false)
      .catch((e: unknown) => setMarkError(errorMessage(e)))
      .finally(() => setDeepening(false));
  };
  return (
    <>
      <Markdown text={item.prompt} class="learn-prompt" />
      {revealed ? (
        <>
          {marked ? <MarkedView marked={marked} /> : null}
          {followedUpMarked ? (
            <details class="follow-ups-done">
              <summary class="muted">What you said</summary>
              <FollowUpTurns exchange={followedUpMarked} />
            </details>
          ) : null}
          <section class="learn-answer" aria-label="Answer">
            <Markdown text={item.answer} />
            {item.explanation ? <Markdown text={item.explanation} class="muted" /> : null}
          </section>
          {marked && !flagging ? (
            <button type="button" class="pill primary wide" onClick={onMarked}>
              Next
            </button>
          ) : null}
          {flagging ? (
            <form
              class="learn-flag"
              onSubmit={(event) => {
                event.preventDefault();
                onFlag(note.trim());
              }}
            >
              <label>
                What's wrong? (optional)
                <input
                  type="text"
                  value={note}
                  onInput={(event) => setNote(event.currentTarget.value)}
                />
              </label>
              <span class="learn-actions">
                <button type="button" class="pill" onClick={() => setFlagging(false)}>
                  Cancel
                </button>
                <button type="submit" class="pill primary">
                  Flag it
                </button>
              </span>
            </form>
          ) : marked ? (
            <button type="button" class="learn-link" onClick={() => setFlagging(true)}>
              This is wrong
            </button>
          ) : (
            <>
              <p class="learn-question muted">How well did you know it?</p>
              <div class="learn-ratings">
                {(
                  [
                    ["again", "Forgot"],
                    ["hard", "Hard"],
                    ["good", "Good"],
                    ["easy", "Easy"],
                  ] as const
                ).map(([rating, label]) => (
                  <button
                    key={rating}
                    type="button"
                    class={`pill rating ${rating}`}
                    onClick={() => onRate(rating)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <button type="button" class="learn-link" onClick={() => setFlagging(true)}>
                This is wrong
              </button>
            </>
          )}
        </>
      ) : exchange ? (
        <FollowUpsView
          itemKey={item.key}
          exchange={exchange}
          error={exchangeError}
          about={exchangeAbout}
          serverDictation={serverDictation}
          onMarked={(reply, done) => {
            setMarked(reply.marked);
            setFollowedUpMarked(done);
            setRevealed(true);
          }}
          onShowAnswer={() => setRevealed(true)}
          onOver={(why) => {
            setExchange(null);
            setExchangeError(null);
            setExchangeAbout(null);
            setOverWhy(why);
            setAnswering(null);
            exchangeId.current = newId();
          }}
        />
      ) : resume === "loading" && !begun ? (
        <p class="muted" role="status">
          Loading your follow-up questions…
        </p>
      ) : answering === "aloud" ? (
        <>
          <ExplainAloud
            itemKey={item.key}
            work="card"
            question="Your answer, explained aloud"
            serverDictation={serverDictation}
            onMarked={(reply) => {
              setMarked(reply.marked);
              setRevealed(true);
            }}
            {...(offersFollowUps ? { onDeeper: (heard: string) => goDeeper(heard, true) } : {})}
            onBusy={setAloudBusy}
          />
          <button
            type="button"
            class="learn-link"
            disabled={busy}
            onClick={() => setRevealed(true)}
          >
            Show answer
          </button>
        </>
      ) : answering === "writing" ? (
        <form
          class="learn-form"
          onSubmit={(event) => {
            event.preventDefault();
            mark();
          }}
        >
          <label class="learn-question muted" for="card-own-words">
            Your answer, in your own words
          </label>
          <textarea
            id="card-own-words"
            class="written"
            rows={4}
            value={written}
            readOnly={busy}
            onInput={(event) => setWritten(event.currentTarget.value)}
          />
          {markError ? (
            <p class="error-text" role="alert">
              {markError}
            </p>
          ) : null}
          <span class="learn-actions">
            {/* With follow-ups to offer, showing the answer is a link below, to leave room. */}
            {offersFollowUps ? (
              <button
                type="button"
                class="pill"
                disabled={busy || !online || !written.trim()}
                onClick={goDeeperWritten}
              >
                {deepening ? "Asking…" : "Go deeper"}
              </button>
            ) : (
              <button type="button" class="pill" disabled={busy} onClick={() => setRevealed(true)}>
                Show answer
              </button>
            )}
            <button
              type="submit"
              class="pill primary"
              disabled={busy || !online || !written.trim()}
            >
              {marking ? "Marking…" : "Mark my answer"}
            </button>
          </span>
          {online ? (
            offersFollowUps ? (
              <p class="muted explain-hint">
                Go deeper to answer the tutor's follow-up questions on it before it's marked.
              </p>
            ) : null
          ) : (
            <p class="muted explain-hint">
              {offersFollowUps
                ? "Marking it, and going deeper, need the server."
                : "Marking it needs the server."}
            </p>
          )}
          {offersFollowUps ? (
            <button
              type="button"
              class="learn-link"
              disabled={busy}
              onClick={() => setRevealed(true)}
            >
              Show answer
            </button>
          ) : null}
        </form>
      ) : (
        <>
          {resume === "waiting" && !online ? (
            <p class="muted" role="status">
              Follow-up questions on this card are under way, but they need the server. Until it can
              be reached, answer it as usual.
            </p>
          ) : null}
          {resume === "failed" ? (
            <div class="learn-resume" role="alert">
              <p class="error-text">Couldn't load your follow-up questions: {resumeError}</p>
              <button type="button" class="pill" onClick={() => setResume("waiting")}>
                Try again
              </button>
            </div>
          ) : null}
          {overWhy ? (
            <p class="muted" role="status">
              {overWhy}
            </p>
          ) : null}
          <button type="button" class="pill primary wide" onClick={() => setRevealed(true)}>
            Show answer
          </button>
          <span class="learn-links">
            <button type="button" class="learn-link" onClick={() => setAnswering("writing")}>
              Answer in my own words
            </button>
            <button type="button" class="learn-link" onClick={() => setAnswering("aloud")}>
              Explain it aloud
            </button>
          </span>
        </>
      )}
    </>
  );
}

/** Code to read, and a question about it: what it prints, or a choice of answers. */
function ReadingView({
  item,
  onAnswer,
  onNext,
  onChoose,
}: {
  item: Extract<DeckItem, { kind: "reading" }>;
  onAnswer: (response: string | null, right: boolean) => void;
  onNext: (right: boolean) => void;
  /** After a right answer, which only goes on once the learner chooses. */
  onChoose: (choice: Choice) => void;
}) {
  const [response, setResponse] = useState("");
  const [right, setRight] = useState<boolean | null>(null);
  const [chosen, setChosen] = useState<number | null>(null);
  const answer = (given: string | null, correct: boolean) => {
    if (right !== null) return;
    setRight(correct);
    onAnswer(given, correct);
  };
  return (
    <>
      <Markdown text={item.prompt} class="learn-prompt" />
      {item.ask === "prints" ? (
        <form
          class="learn-form"
          onSubmit={(event) => {
            event.preventDefault();
            answer(response, sameOutput(item.output, response));
          }}
        >
          <label class="learn-question muted" for="learn-output">
            What it prints
          </label>
          <textarea
            id="learn-output"
            class="learn-output"
            rows={3}
            autoComplete="off"
            autoCorrect="off"
            spellcheck={false}
            value={response}
            readOnly={right !== null}
            onInput={(event) => setResponse(event.currentTarget.value)}
          />
          {right === null ? (
            <span class="learn-actions">
              <button type="button" class="pill" onClick={() => answer(null, false)}>
                I don't know
              </button>
              <button type="submit" class="pill primary">
                Check
              </button>
            </span>
          ) : null}
        </form>
      ) : (
        <ol class="learn-choices">
          {item.choices.map((choice, index) => (
            <li key={choice}>
              <button
                type="button"
                class={`pill learn-choice ${
                  right === null
                    ? ""
                    : index === item.answer
                      ? "right"
                      : index === chosen
                        ? "wrong"
                        : ""
                }`}
                aria-pressed={chosen === index}
                disabled={right !== null}
                onClick={() => {
                  setChosen(index);
                  answer(String(index + 1), index === item.answer);
                }}
              >
                {choice}
              </button>
            </li>
          ))}
        </ol>
      )}
      {right !== null ? (
        <section class={`learn-answer ${right ? "right" : "wrong"}`} aria-label="Answer">
          <p class="learn-verdict">
            {right
              ? "Right"
              : item.ask === "prints"
                ? "It prints:"
                : `It's: ${item.choices[item.answer]}`}
          </p>
          {!right && item.ask === "prints" ? <pre class="learn-printed">{item.output}</pre> : null}
          <Markdown text={item.explanation} class="muted" />
          {right ? (
            <ChoiceAfterRight onChoose={onChoose} />
          ) : (
            <NextButton onNext={onNext} right={false} />
          )}
        </section>
      ) : null}
    </>
  );
}

/** What to do with an item with a fixed answer once it's answered right. */
type Choice = "got-it" | "retire";

/** Goes on to the next item, focused, so Enter does it. */
function NextButton({ right, onNext }: { right: boolean; onNext: (right: boolean) => void }) {
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => next.current?.focus(), []);
  return (
    <button ref={next} type="button" class="pill primary wide" onClick={() => onNext(right)}>
      Next
    </button>
  );
}

/**
 * After a right answer to an item with a fixed answer: "Got it" sends it much further off, and
 * "Too easy" retires it, as seen again it would test memory of the answer, not the concept.
 * "Got it" is focused, so Enter chooses it, and Tab moves to retiring.
 */
function ChoiceAfterRight({ onChoose }: { onChoose: (choice: Choice) => void }) {
  const gotIt = useRef<HTMLButtonElement>(null);
  useEffect(() => gotIt.current?.focus(), []);
  return (
    <div class="learn-choice-after">
      <button ref={gotIt} type="button" class="pill primary" onClick={() => onChoose("got-it")}>
        Got it
      </button>
      <button type="button" class="pill" onClick={() => onChoose("retire")}>
        Too easy: retire it
      </button>
    </div>
  );
}

/** A question answered by typing a number, checked straight away, on the device. */
function TypedAnswer({
  prompt,
  tolerance,
  estimate = null,
  markdown = false,
  numbersOnly = false,
  onAnswer,
  onNext,
  onChoose,
}: {
  prompt: Instance;
  tolerance: Extract<DeckItem, { kind: "probability" }>["tolerance"];
  /** How close an estimate must be, such as "within 5%", shown with the question; null if exact. */
  estimate?: string | null;
  markdown?: boolean;
  /**
   * Whether a phone's number pad is enough to answer. It has no "/", "%" or, on some phones, "-",
   * so fractions, percentages and negative numbers need the full keyboard.
   */
  numbersOnly?: boolean;
  onAnswer: (instance: Instance, response: string | null, right: boolean) => void;
  onNext: (right: boolean) => void;
  /** For a question with a fixed answer: once it's answered right, which only goes on once the
   * learner chooses. Questions made afresh each time go straight on. */
  onChoose?: (choice: Choice) => void;
}) {
  // The question stays the one first shown, even once answering it moves the deck on.
  const [instance] = useState(prompt);
  const [response, setResponse] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [right, setRight] = useState<boolean | null>(null);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.focus(), []);

  const check = (event: Event) => {
    event.preventDefault();
    if (right !== null) return;
    const graded = grade(instance.answer, tolerance, response);
    if (graded === null) {
      setProblem("Type a number, such as 42, 0.25, 1/4 or 25%.");
      return;
    }
    setProblem(null);
    setRight(graded);
    onAnswer(instance, response, graded);
  };
  const giveUp = () => {
    setRight(false);
    onAnswer(instance, null, false);
  };

  return (
    <>
      {markdown ? (
        <Markdown text={instance.prompt} class="learn-prompt" />
      ) : (
        <p class="learn-prompt learn-sum">{instance.prompt}</p>
      )}
      {estimate ? <p class="learn-estimate muted">An estimate: {estimate} counts.</p> : null}
      <form class="learn-form" onSubmit={check}>
        <label class="visually-hidden" for="learn-response">
          Your answer
        </label>
        <input
          id="learn-response"
          ref={input}
          type="text"
          inputMode={numbersOnly ? "decimal" : "text"}
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          value={response}
          readOnly={right !== null}
          onInput={(event) => setResponse(event.currentTarget.value)}
        />
        {right === null ? (
          <span class="learn-actions">
            <button type="button" class="pill" onClick={giveUp}>
              I don't know
            </button>
            <button type="submit" class="pill primary">
              Check
            </button>
          </span>
        ) : null}
      </form>
      {problem ? <p class="error-text">{problem}</p> : null}
      {right !== null ? (
        <section class={`learn-answer ${right ? "right" : "wrong"}`} aria-label="Answer">
          <p class="learn-verdict">
            {estimate
              ? `${right ? "Close enough" : "Not close enough"}: it's ${displayApproximate(instance.answer)}`
              : right
                ? "Right"
                : `The answer is ${displayNumber(instance.answer)}`}
          </p>
          {instance.method ? <Markdown text={instance.method} class="muted" /> : null}
          {right && onChoose ? (
            <ChoiceAfterRight onChoose={onChoose} />
          ) : (
            <NextButton onNext={onNext} right={right} />
          )}
        </section>
      ) : null}
    </>
  );
}

function Done({
  deck,
  track,
  results,
  onAgain,
  onHome,
}: {
  deck: Deck;
  track: TrackId;
  results: Result[];
  onAgain: () => void;
  onHome: () => void;
}) {
  const state = learning();
  const now = Date.now();
  const left = queue(
    deck,
    track,
    state.attempts,
    state.flagChanges,
    state.retirementChanges,
    now,
    utcOffset(),
  );
  const more = left.followUps.length + left.due.length + left.fresh.length;
  const keptApart = limitsOf(deck, track) !== null;
  const week = progress(deck, state.attempts, now, utcOffset(), track);
  // A track can have only problems, listed below, and nothing to practise a few at a time.
  const hasShort = deck.items.some((item) => item.track === track);
  const answered = results.filter((r) => r.right !== null);
  const skills = useMemo(() => {
    const ids = new Set(deck.items.filter((i) => i.track === track).flatMap((i) => i.skills));
    return deck.skills.filter((skill) => ids.has(skill.id));
  }, [deck, track]);
  return (
    <section class="learn-done" aria-label="Done">
      {results.length === 0 ? (
        hasShort ? (
          <h2>Nothing to do here for now</h2>
        ) : null
      ) : (
        <h2>
          That's a step done
          {answered.length > 0
            ? `: ${answered.filter((r) => r.right).length} of ${answered.length} right`
            : ""}
        </h2>
      )}
      <p class="muted">
        {keptApart
          ? `${week.minutesThisWeek} minutes here this week, kept apart from the week's target`
          : `${week.minutesThisWeek} of ${deck.limits.weekly_minutes} minutes this week`}
        {left.waiting > 0 ? ` · ${left.waiting} more due tomorrow` : ""}
        {left.freshWaiting > 0 ? ` · ${left.freshWaiting} more new tomorrow` : ""}
      </p>
      <span class="learn-actions">
        <button type="button" class="pill" onClick={onHome}>
          Home
        </button>
        {more > 0 ? (
          <button type="button" class="pill primary" onClick={onAgain}>
            Another step
          </button>
        ) : null}
      </span>
      <RetiredList
        items={retired(deck, track, state.retirementChanges)}
        onBringBack={(key) => state.bringBack(key)}
      />
      {skills.length > 0 ? (
        <section aria-labelledby="skills-heading">
          <h3 id="skills-heading" class="tracks-heading">
            Skills
          </h3>
          <ul class="learn-skills">
            {skills.map((skill) => (
              <li key={skill.id}>
                <span>{skill.name}</span>
                <meter
                  class="meter"
                  aria-label={`${skill.name} mastered`}
                  min={0}
                  max={1}
                  value={skill.mastery}
                />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

/**
 * The coding problems in a track other than Coding, such as a pack's own, to open one at a
 * time, and those retired, to bring back. They need the server, so offline there's nothing.
 */
function TrackProblems({ track, onOpen }: { track: TrackId; onOpen: (item: string) => void }) {
  const online = useConnection();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [bringing, setBringing] = useState<string | null>(null);
  const [bringError, setBringError] = useState<string | null>(null);
  useEffect(() => {
    if (!online) return;
    codingApi.overview(track).then(setOverview, () => setOverview(null));
  }, [track, online]);
  const problems = (overview?.items ?? []).filter((item) => item.kind === "coding");
  if (problems.length === 0) return null;
  const bringBack = (key: string) => {
    setBringing(key);
    setBringError(null);
    codingApi
      .bringBack(key, newId())
      .then(() => codingApi.overview(track))
      .then(setOverview, (e: unknown) => setBringError(errorMessage(e)))
      .finally(() => setBringing(null));
  };
  return (
    <section class="learn-problems" aria-labelledby="problems-heading">
      <h2 id="problems-heading" class="tracks-heading">
        Problems
      </h2>
      <CodingItems items={toDo(problems)} online={online} onOpen={onOpen} />
      <RetiredList
        items={problems.filter((item) => item.status === "retired")}
        bringing={bringing}
        disabled={!online}
        error={bringError}
        onBringBack={bringBack}
      />
    </section>
  );
}
