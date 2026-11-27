import { useEffect, useRef, useState } from "preact/hooks";
import { ApiError, ConnectionError, connection } from "../api";
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
import {
  completedLessons,
  dayStart,
  type FlowEntry,
  lastRating,
  limitsOf,
  newId,
  nextInstance,
  progress,
  queue,
  retired,
  skippedLessons,
  step,
  utcOffset,
} from "./local";
import { sameOutput } from "./output";
import "./practice.css";
import { TrackLessons } from "./lesson";
import { RetiredList } from "./retired";
import { learning, type SyncStatus } from "./sync";
import type { Attempt, Deck, DeckItem, DeckLesson, Instance, Rating } from "./types";

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

/** One result in a sitting: whether it was right, or null for a card or lesson. */
type Result = { key: string; right: boolean | null };

/** One entry in a practice step: either a short item or a lesson card offered before new items. */
export type FlowRef = { kind: "item" | "lesson"; key: string };

/** Options when opening a lesson from a track's practice flow or a short item. */
export interface OpenLessonOptions {
  /** Counting from 0, to revisit just that segment without adding a completion. */
  segmentIndex?: number | null;
  /** Skip the lesson's opening card when started directly from the flow's lesson card. */
  autoStart?: boolean;
  /** Track to return to on finishing or going back. */
  returnToTrack?: TrackId;
}

/** Practice flow state kept across opening a lesson so returning carries right on. */
export interface PracticeFlow {
  step: { entries: FlowRef[]; at: number } | null;
  results: Result[];
  seenLessons: string[];
  excludeNext: string[];
  startedLesson?: { key: string; completionsBefore: number } | null;
}

/** The week's minutes, for the target every track shares or a track kept apart from it. */
function weekTime(deck: Deck, track: TrackId, minutes: number, detail = false): string {
  if (limitsOf(deck, track) !== null) {
    return detail
      ? `${minutes} minutes here this week, kept apart from the week's target`
      : `${minutes} minutes here this week`;
  }
  return `${minutes} of ${deck.limits.weekly_minutes} minutes this week`;
}

function flowRefsOf(entries: FlowEntry[]): FlowRef[] {
  return entries.map((entry) =>
    entry.kind === "item"
      ? { kind: "item", key: entry.item.key }
      : { kind: "lesson", key: entry.lesson.key },
  );
}

/**
 * Practising a track: follow-ups and due reviews first, then the track's next lesson (if any),
 * then unlocked new items, flowing from one to the next until nothing's left for now. Every
 * answer is saved on the device as it's given and synced when the server can be reached, so it
 * can be left at any moment, and works offline.
 */
export function Practice({
  track,
  serverDictation,
  initialFlow = null,
  onSaveFlow,
  onHome,
  onOpenProblem,
  onOpenLesson,
}: {
  track: TrackId;
  /** Whether Whisper is ready on the server, for explaining answers aloud. */
  serverDictation: boolean;
  /** Suspended flow restored when returning from a lesson opened during this sitting. */
  initialFlow?: PracticeFlow | null;
  /** Saves the flow before navigating to a lesson so finishing or going back carries on. */
  onSaveFlow?: (flow: PracticeFlow) => void;
  onHome: () => void;
  /** Opens one of the track's coding problems, by its key. */
  onOpenProblem: (item: string) => void;
  /** Opens a lesson, optionally at a single segment or auto-started from the flow. */
  onOpenLesson: (item: string, options?: OpenLessonOptions) => void;
}) {
  const state = useLearning();
  const deck = state.deck;
  // Consume any suspended flow once on mount, checking whether a started lesson was completed.
  const [restored] = useState<{
    step: { entries: FlowRef[]; at: number } | null;
    results: Result[];
    seenLessons: string[];
    excludeNext: string[];
    fromFlow: boolean;
  }>(() => {
    if (!initialFlow) {
      return { step: null, results: [], seenLessons: [], excludeNext: [], fromFlow: false };
    }
    const results = [...initialFlow.results];
    if (initialFlow.startedLesson && state.deck) {
      const done =
        completedLessons(state.deck, state.lessonCompletions)[initialFlow.startedLesson.key]
          ?.length ?? 0;
      if (done > initialFlow.startedLesson.completionsBefore) {
        results.push({ key: initialFlow.startedLesson.key, right: null });
      }
    }
    return {
      step: initialFlow.step,
      results,
      seenLessons: initialFlow.seenLessons,
      excludeNext: initialFlow.excludeNext,
      fromFlow: true,
    };
  });

  // The full list of entries in the step under way and where the learner is in it; keeping the
  // whole step lets the next step exclude only the one just finished, while still allowing
  // forgotten items to return in a later step of the same sitting.
  const [currentStep, setCurrentStep] = useState<{ entries: FlowRef[]; at: number } | null>(
    restored.step,
  );
  const [results, setResults] = useState<Result[]>(restored.results);
  const seenLessonsRef = useRef<Set<string>>(new Set(restored.seenLessons));
  // The deck's ready once it's been fetched, or right away if the device has one.
  const [tried, setTried] = useState(false);

  useEffect(() => {
    void state.sync().finally(() => setTried(true));
  }, []);

  const pickStep = (from: Deck, exclude: ReadonlySet<string> = new Set()): FlowRef[] => {
    const combinedExclude = new Set([...exclude, ...seenLessonsRef.current]);
    return flowRefsOf(
      step(
        queue(
          from,
          track,
          state.attempts,
          state.flagChanges,
          state.retirementChanges,
          Date.now(),
          utcOffset(),
          state.lessonCompletions,
          state.lessonSkips,
        ),
        combinedExclude,
      ),
    );
  };

  const startStep = (exclude: ReadonlySet<string> = new Set()) => {
    const currentDeck = state.deck;
    if (!currentDeck) return;
    setCurrentStep({ entries: pickStep(currentDeck, exclude), at: 0 });
    if (!restored.fromFlow) {
      setResults([]);
      begun.current = false;
    }
  };
  // The first step starts once there's a deck, from the device or the server.
  useEffect(() => {
    if (deck && currentStep === null) {
      startStep(new Set(restored.excludeNext));
    }
  }, [deck !== null]);
  // Whether anything's been begun in the sitting, typed or tapped, so it isn't taken away.
  const begun = useRef(restored.fromFlow);
  // A step started from the device's deck, before it synced, is started again if the server
  // says a card has follow-up questions under way that it doesn't start with, such as ones
  // started on another device, unless anything in it's been begun.
  useEffect(() => {
    if (!tried || !deck || currentStep === null || results.length > 0 || begun.current) return;
    const q = queue(
      deck,
      track,
      state.attempts,
      state.flagChanges,
      state.retirementChanges,
      Date.now(),
      utcOffset(),
      state.lessonCompletions,
      state.lessonSkips,
    );
    const followUpChanged = q.followUps.some(
      (item, at) =>
        currentStep.entries[at]?.kind !== "item" || currentStep.entries[at]?.key !== item.key,
    );
    const firstIsStaleLesson =
      currentStep.entries[0]?.kind === "lesson" && currentStep.entries[0]?.key !== q.lesson?.key;
    if (followUpChanged || firstIsStaleLesson) startStep();
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

  if (currentStep === null) return <div class="learn">{header}</div>;

  const now = Date.now();
  const offset = utcOffset();
  const today = dayStart(now, offset);
  const completed = completedLessons(deck, state.lessonCompletions);
  const skipped = skippedLessons(deck, state.lessonSkips);
  const resolveEntry = (ref: FlowRef): FlowEntry | undefined => {
    if (ref.kind === "item") {
      const item = deck.items.find((i) => i.key === ref.key);
      return item ? { kind: "item", item } : undefined;
    }
    const lesson = (deck.lessons ?? []).find((l) => l.key === ref.key);
    if (!lesson) return undefined;
    if ((completed[lesson.key]?.length ?? 0) > 0) return undefined;
    if (skipped[lesson.key]?.some((at) => at >= today)) return undefined;
    return { kind: "lesson", lesson };
  };

  const current = currentStep.entries
    .slice(currentStep.at)
    .map(resolveEntry)
    .find((entry): entry is FlowEntry => entry !== undefined);
  const week = progress(deck, state.attempts, now, offset, track, state.lessonCompletions);

  const computeNextAfter = (
    ref: FlowRef,
    nextResults: Result[],
    extraSeenLesson?: string,
  ): {
    step: { entries: FlowRef[]; at: number } | null;
    excludeNext: string[];
    results: Result[];
  } => {
    if (extraSeenLesson) seenLessonsRef.current.add(extraSeenLesson);
    const at = currentStep.entries.findIndex(
      (e, index) => index >= currentStep.at && e.kind === ref.kind && e.key === ref.key,
    );
    const nextAt = at === -1 ? currentStep.entries.length : at + 1;
    const hasMoreInStep = currentStep.entries
      .slice(nextAt)
      .some((e) => resolveEntry(e) !== undefined);
    if (hasMoreInStep) {
      return {
        step: { entries: currentStep.entries, at: nextAt },
        excludeNext: [],
        results: nextResults,
      };
    }
    return {
      step: null,
      excludeNext: currentStep.entries.map((e) => e.key),
      results: nextResults,
    };
  };

  const advancePast = (ref: FlowRef, result: Result | null, extraSeenLesson?: string) => {
    const nextResults = result ? [...results, result] : results;
    const next = computeNextAfter(ref, nextResults, extraSeenLesson);
    setResults(next.results);
    const currentDeck = state.deck;
    if (next.step) {
      setCurrentStep(next.step);
    } else if (currentDeck) {
      setCurrentStep({ entries: pickStep(currentDeck, new Set(next.excludeNext)), at: 0 });
    } else {
      setCurrentStep({ entries: [], at: 0 });
    }
  };

  const finishItem = (key: string, right: boolean | null) => {
    advancePast({ kind: "item", key }, { key, right });
  };

  const openLessonFromItem = (
    itemKey: string,
    lessonKey: string,
    segmentIndex: number | null,
    right: boolean | null,
  ) => {
    const nextResults = [...results, { key: itemKey, right }];
    const next = computeNextAfter({ kind: "item", key: itemKey }, nextResults);
    onSaveFlow?.({
      step: next.step,
      results: next.results,
      seenLessons: [...seenLessonsRef.current],
      excludeNext: next.excludeNext,
      startedLesson: null,
    });
    onOpenLesson(lessonKey, { segmentIndex, returnToTrack: track });
  };

  const startFlowLesson = (lesson: DeckLesson) => {
    const completionsBefore = completed[lesson.key]?.length ?? 0;
    const next = computeNextAfter({ kind: "lesson", key: lesson.key }, results, lesson.key);
    onSaveFlow?.({
      step: next.step,
      results: next.results,
      seenLessons: [...seenLessonsRef.current],
      excludeNext: next.excludeNext,
      startedLesson: { key: lesson.key, completionsBefore },
    });
    onOpenLesson(lesson.key, { autoStart: true, returnToTrack: track });
  };

  const skipFlowLesson = (lesson: DeckLesson) => {
    state.skipLesson({ id: newId(), lesson: lesson.key, skipped_at: Date.now() });
    advancePast({ kind: "lesson", key: lesson.key }, null, lesson.key);
  };

  const bringBack = (key: string) => {
    state.bringBack(key);
    const currentDeck = state.deck;
    if (!currentDeck) return;
    const nextEntries = pickStep(currentDeck);
    if (nextEntries.length > 0) setCurrentStep({ entries: nextEntries, at: 0 });
  };

  return (
    <div class="learn">
      {header}
      {state.syncStatus.error ? (
        <div class="banner" role="alert">
          Couldn't sync: {state.syncStatus.error}. Your answers are kept on this device.
        </div>
      ) : null}
      <main
        class="learn-content"
        onInputCapture={() => {
          begun.current = true;
        }}
        onClickCapture={() => {
          begun.current = true;
        }}
      >
        {current ? (
          <>
            <p class="learn-count muted">
              {results.length > 0 ? `${results.length} done · ` : ""}
              {weekTime(deck, track, week.minutesThisWeek)}
            </p>
            {current.kind === "lesson" ? (
              <LessonFlowCard
                key={current.lesson.key}
                lesson={current.lesson}
                onStart={() => startFlowLesson(current.lesson)}
                onSkip={() => skipFlowLesson(current.lesson)}
              />
            ) : (
              <ItemView
                key={`${current.item.key}-${results.length}`}
                item={current.item}
                followedUp={deck.follow_ups?.includes(current.item.key) ?? false}
                serverDictation={serverDictation}
                onDone={(right) => finishItem(current.item.key, right)}
                onOpenLesson={(lessonKey, segmentIndex, right) =>
                  openLessonFromItem(current.item.key, lessonKey, segmentIndex, right)
                }
              />
            )}
          </>
        ) : (
          <>
            <Done
              deck={deck}
              track={track}
              results={results}
              onHome={onHome}
              onBringBack={bringBack}
            />
            <TrackLessons deck={deck} track={track} onOpen={(item) => onOpenLesson(item)} />
            <TrackProblems track={track} onOpen={onOpenProblem} />
          </>
        )}
      </main>
    </div>
  );
}

/** A short card offered in the practice flow for the track's next lesson, before new items. */
function LessonFlowCard({
  lesson,
  onStart,
  onSkip,
}: {
  lesson: DeckLesson;
  onStart: () => void;
  onSkip: () => void;
}) {
  return (
    <article class="lesson-flow-card" aria-label={`Lesson: ${lesson.title}`}>
      <div class="lesson-head">
        <p class="lesson-meta muted">Lesson · ~{lesson.minutes} min</p>
        <h2 class="lesson-title">{lesson.title}</h2>
      </div>
      <Markdown text={lesson.prompt} class="learn-prompt" />
      <div class="lesson-flow-actions">
        <button type="button" class="pill primary" onClick={onStart}>
          Start
        </button>
        <button type="button" class="pill" onClick={onSkip}>
          Not now
        </button>
      </div>
    </article>
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
  onOpenLesson,
}: {
  item: DeckItem;
  /** Whether it's a card with follow-up questions under way, to carry on with. */
  followedUp?: boolean;
  serverDictation: boolean;
  onDone: (right: boolean | null) => void;
  /** Opens the item's lesson (or a single segment) via "Teach me" or "Revisit the lesson". */
  onOpenLesson?: (lessonKey: string, segmentIndex: number | null, right: boolean | null) => void;
}) {
  const shown = useRef(Date.now());
  // Remember whether the previous attempt was wrong/Forgot before this attempt is recorded.
  const [previousWasAgain] = useState(() => {
    const currentDeck = learning().deck;
    return currentDeck ? lastRating(currentDeck, learning().attempts, item.key) === "again" : false;
  });
  const linkedLesson = (() => {
    if (!item.lesson || !onOpenLesson) return null;
    const currentDeck = learning().deck;
    return currentDeck?.lessons?.find((l) => l.key === item.lesson) ?? null;
  })();
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
  const teachMe = (right: boolean | null, extra: { seed?: number } = {}) => {
    if (!linkedLesson || !onOpenLesson) return;
    record("again", extra);
    const currentDeck = learning().deck;
    const done = currentDeck
      ? (completedLessons(currentDeck, learning().lessonCompletions)[linkedLesson.key]?.length ??
          0) > 0
      : false;
    const segmentIndex = done && item.segment != null ? item.segment : null;
    onOpenLesson(linkedLesson.key, segmentIndex, right);
  };
  const revisit = (right: boolean | null) => {
    if (!linkedLesson || !onOpenLesson) return;
    onOpenLesson(linkedLesson.key, item.segment ?? null, right);
  };
  const canRevisit = linkedLesson !== null && previousWasAgain;
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
          canRevisit={canRevisit}
          onRate={(rating) => {
            record(rating);
            onDone(null);
          }}
          onLapsedAgain={() => record("again")}
          onMarked={() => onDone(null)}
          onTeachMe={linkedLesson ? () => teachMe(null) : undefined}
          onRevisit={canRevisit ? () => revisit(null) : undefined}
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
        <ReadingView
          item={item}
          onAnswer={answerFixed}
          onNext={onDone}
          onChoose={choose}
          onTeachMe={linkedLesson ? () => teachMe(false) : undefined}
          onRevisit={canRevisit ? () => revisit(false) : undefined}
        />
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
          onTeachMe={
            linkedLesson ? (instance) => teachMe(false, { seed: instance.seed }) : undefined
          }
          onRevisit={canRevisit ? () => revisit(false) : undefined}
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
          onTeachMe={linkedLesson ? () => teachMe(false) : undefined}
          onRevisit={canRevisit ? () => revisit(false) : undefined}
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
  canRevisit,
  onRate,
  onLapsedAgain,
  onMarked,
  onTeachMe,
  onRevisit,
  onFlag,
}: {
  item: Extract<DeckItem, { kind: "card" }>;
  /** Whether it has follow-up questions under way, to carry on with. */
  followedUp: boolean;
  serverDictation: boolean;
  /** Whether a Forgot rating triggers "Revisit the lesson" beside Next. */
  canRevisit: boolean;
  onRate: (rating: Rating) => void;
  /** Records a second consecutive Forgot rating while keeping the answer screen open. */
  onLapsedAgain: () => void;
  /** Once the grader has marked an answer in the learner's own words, which it records. */
  onMarked: () => void;
  onTeachMe?: (() => void) | undefined;
  onRevisit?: (() => void) | undefined;
  onFlag: (note: string) => void;
}) {
  const [revealed, setRevealed] = useState(false);
  const [lapsedAgain, setLapsedAgain] = useState(false);
  const [flagging, setFlagging] = useState(false);
  const [note, setNote] = useState("");
  /** Answering in the learner's own words, written or explained aloud, for the grader. */
  const [answering, setAnswering] = useState<"writing" | "aloud" | null>(null);
  const [written, setWritten] = useState("");
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [marked, setMarked] = useState<Marked | null>(null);
  const [markedRating, setMarkedRating] = useState<Rating | null>(null);
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
          setMarkedRating(reply.attempt?.rating ?? null);
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
      // Those with this id were marked, as on another device, so going deeper again starts
      // afresh.
      if (e instanceof ApiError && e.status === 409) {
        exchangeId.current = newId();
        throw e;
      }
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
          {lapsedAgain && !flagging && onRevisit ? (
            <AfterWrong onNext={onMarked} onRevisit={onRevisit} />
          ) : marked && !flagging ? (
            canRevisit && markedRating === "again" && onRevisit ? (
              <AfterWrong onNext={onMarked} onRevisit={onRevisit} />
            ) : (
              <button type="button" class="pill primary wide" onClick={onMarked}>
                Next
              </button>
            )
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
          ) : marked || lapsedAgain ? (
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
                    onClick={() => {
                      if (rating === "again" && canRevisit && onRevisit) {
                        onLapsedAgain();
                        setLapsedAgain(true);
                      } else {
                        onRate(rating);
                      }
                    }}
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
            setMarkedRating(reply.attempt?.rating ?? null);
            setFollowedUpMarked(done);
            setRevealed(true);
          }}
          onShowAnswer={() => setRevealed(true)}
          onOver={(why) => {
            setAloudBusy(false);
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
              setMarkedRating(reply.attempt?.rating ?? null);
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
            {onTeachMe ? (
              <button type="button" class="learn-link" onClick={onTeachMe}>
                Teach me
              </button>
            ) : null}
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
  onTeachMe,
  onRevisit,
}: {
  item: Extract<DeckItem, { kind: "reading" }>;
  onAnswer: (response: string | null, right: boolean) => void;
  onNext: (right: boolean) => void;
  /** After a right answer, which only goes on once the learner chooses. */
  onChoose: (choice: Choice) => void;
  onTeachMe?: (() => void) | undefined;
  onRevisit?: (() => void) | undefined;
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
      {right === null && onTeachMe ? (
        <span class="learn-links">
          <button type="button" class="learn-link" onClick={onTeachMe}>
            Teach me
          </button>
        </span>
      ) : null}
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
          ) : onRevisit ? (
            <AfterWrong onNext={() => onNext(false)} onRevisit={onRevisit} />
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

/** After two consecutive lapses on an item with a lesson: Next (focused) beside revisiting it. */
function AfterWrong({ onNext, onRevisit }: { onNext: () => void; onRevisit: () => void }) {
  const next = useRef<HTMLButtonElement>(null);
  useEffect(() => next.current?.focus(), []);
  return (
    <div class="learn-choice-after">
      <button ref={next} type="button" class="pill primary" onClick={onNext}>
        Next
      </button>
      <button type="button" class="pill" onClick={onRevisit}>
        Revisit the lesson
      </button>
    </div>
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
  onTeachMe,
  onRevisit,
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
  onTeachMe?: ((instance: Instance) => void) | undefined;
  onRevisit?: (() => void) | undefined;
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
      {right === null && onTeachMe ? (
        <span class="learn-links">
          <button type="button" class="learn-link" onClick={() => onTeachMe(instance)}>
            Teach me
          </button>
        </span>
      ) : null}
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
          ) : !right && onRevisit ? (
            <AfterWrong onNext={() => onNext(false)} onRevisit={onRevisit} />
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
  onHome,
  onBringBack,
}: {
  deck: Deck;
  track: TrackId;
  results: Result[];
  onHome: () => void;
  onBringBack: (key: string) => void;
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
    state.lessonCompletions,
    state.lessonSkips,
  );
  const week = progress(deck, state.attempts, now, utcOffset(), track, state.lessonCompletions);
  // A track can have only problems, listed below, and no short items to practise.
  const hasShort = deck.items.some((item) => item.track === track);
  const answered = results.filter((r) => r.right !== null);
  return (
    <section class="learn-done" aria-label="Done">
      {results.length === 0 ? (
        hasShort ? (
          <h2>Nothing to do here for now</h2>
        ) : null
      ) : (
        <h2>
          That's everything for now
          {answered.length > 0
            ? `: ${answered.filter((r) => r.right).length} of ${answered.length} right`
            : ""}
        </h2>
      )}
      <p class="muted">
        {weekTime(deck, track, week.minutesThisWeek, true)}
        {left.waiting > 0 ? ` · ${left.waiting} more due tomorrow` : ""}
        {left.freshWaiting > 0 ? ` · ${left.freshWaiting} more new tomorrow` : ""}
      </p>
      <span class="learn-actions">
        <button type="button" class="pill" onClick={onHome}>
          Home
        </button>
      </span>
      <RetiredList
        items={retired(deck, track, state.retirementChanges)}
        onBringBack={onBringBack}
      />
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
  const problems = (overview?.items ?? []).filter(
    (item) => item.kind === "coding" || item.kind === "codebase",
  );
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
