import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { gradingApi } from "../grading/api";
import { ExplainAloud } from "../grading/explain";
import { MarkedView } from "../grading/marked";
import type { Marked } from "../grading/types";
import { useConnection } from "../hooks/useConnection";
import { useMarkdown } from "../hooks/useMarkdown";
import { HomeButton, TrackTitle } from "../progress/page";
import { TrackIcon } from "../tracks/icons";
import type { TrackId } from "../tracks/types";
import { DictateButton } from "../views/dictate";
import "./lesson.css";
import {
  advanceKnowCheck,
  answerKnowCheck,
  checkedSegments,
  type KnowCheck,
  markKnowCheck,
  missedSegments,
  offersKnowCheck,
} from "./knowCheck";
import { isSafeHttpUrl, renderLessonHtmlInto, sameLessonImages } from "./lessonMedia";
import {
  advanceFromSegment,
  answerGuess,
  answerSegmentCheck,
  beginKnowCheck,
  clearLessonProgress,
  enterRecap,
  goToSegment,
  type LessonProgress,
  lessonAfterKnowCheck,
  loadLessonProgress,
  saveLessonProgress,
  stampCompletion,
  startLesson,
  updateKnowCheck,
} from "./lessonState";
import { completedLessons, lessonsInTrack, newId, unmetRequires } from "./local";
import { Markdown, SyncChip, useLearning } from "./practice";
import { learning } from "./sync";
import type { Deck, DeckLesson, DeckLessonCheck, DeckLessonImage, DeckLessonSource } from "./types";

/**
 * Segment Markdown with embedded SVG diagrams (DOMPurify-sanitised inline so they take
 * currentColor) and PNG images from the deck.
 */
function LessonMarkdown({
  text,
  images,
  class: className = "",
}: {
  text: string;
  images: Record<string, DeckLessonImage>;
  class?: string;
}) {
  const render = useMarkdown();
  const hostRef = useRef<HTMLDivElement>(null);
  const renderedRef = useRef<{
    host: HTMLDivElement;
    html: string;
    images: Record<string, DeckLessonImage>;
  } | null>(null);

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || render === null) return;
    const html = render(text);
    // Syncing replaces the deck with a freshly parsed copy whose `images` object has identical
    // entries; compare by value so diagrams aren't torn down and re-inserted mid-segment.
    if (
      renderedRef.current?.host === host &&
      renderedRef.current.html === html &&
      sameLessonImages(renderedRef.current.images, images)
    ) {
      return;
    }
    renderedRef.current = { host, html, images };
    renderLessonHtmlInto(host, html, images);
  }, [render, text, images]);

  if (render === null) return <div class={`learn-text ${className}`}>{text}</div>;
  return <div ref={hostRef} class={`learn-text markdown ${className}`} />;
}

/** The lessons in a track, listed with title, rough duration, completion status and unmet prerequisites. */
export function TrackLessons({
  deck,
  track,
  onOpen,
}: {
  deck: Deck;
  track: TrackId;
  onOpen: (key: string) => void;
}) {
  const state = useLearning();
  const lessons = lessonsInTrack(deck, track);
  if (lessons.length === 0) return null;
  const completed = completedLessons(deck, state.lessonCompletions);

  return (
    <section class="learn-lessons" aria-labelledby="lessons-heading">
      <h2 id="lessons-heading" class="tracks-heading">
        Lessons
      </h2>
      <ul class="lesson-list">
        {lessons.map((lesson) => {
          const done = (completed[lesson.key]?.length ?? 0) > 0;
          const unmet = unmetRequires(deck, lesson, completed);
          return (
            <li key={lesson.key}>
              <button type="button" class="lesson-item" onClick={() => onOpen(lesson.key)}>
                <span class="lesson-item-name">{lesson.title}</span>
                <span class="lesson-item-detail muted">
                  {done ? "Done" : "Not done"} · ~{lesson.minutes} min
                  {unmet.length > 0 ? ` · Do first: ${unmet.map((u) => u.title).join(", ")}` : ""}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Predict-then-reveal check shown after a segment, shared by full lessons and single-segment revisits. */
function SegmentCheck({
  check,
  chosen,
  onChoose,
  heading = "Check",
  explain = true,
}: {
  check: DeckLessonCheck;
  chosen: number | undefined;
  onChoose: (choiceIndex: number) => void;
  heading?: string;
  /**
   * Whether answering shows the right answer and its explanation, or, as in "I know this", only
   * whether the choice was right.
   */
  explain?: boolean;
}) {
  const answered = chosen !== undefined;
  const right = chosen === check.answer;
  return (
    <section class="lesson-check" aria-label="Check">
      <h3 class="tracks-heading">{heading}</h3>
      <Markdown text={check.prompt} />
      <ol class="learn-choices">
        {check.choices.map((choice, choiceIndex) => {
          const choiceClass = !answered
            ? ""
            : choiceIndex === chosen
              ? right
                ? "right"
                : "wrong"
              : explain && choiceIndex === check.answer
                ? "right"
                : "";
          return (
            <li key={choice}>
              <button
                type="button"
                class={`pill learn-choice ${choiceClass}`}
                aria-pressed={chosen === choiceIndex}
                disabled={answered}
                onClick={() => onChoose(choiceIndex)}
              >
                {choice}
              </button>
            </li>
          );
        })}
      </ol>
      {answered && explain ? (
        <section class={`learn-answer ${right ? "right" : "wrong"}`} aria-label="Explanation">
          <p class="learn-verdict">{right ? "Right" : `It's: ${check.choices[check.answer]}`}</p>
          <Markdown text={check.explanation} class="muted" />
        </section>
      ) : answered ? (
        <p class={`learn-verdict lesson-know-verdict ${right ? "right" : "wrong"}`} role="status">
          {right ? "Right" : "Not right"}
        </p>
      ) : null}
    </section>
  );
}

/** Typing or dictating an explanation, for a lesson's explain step and "I know this". */
function ExplainInput({
  text,
  disabled,
  serverDictation,
  onText,
  onHeard,
}: {
  text: string;
  disabled: boolean;
  serverDictation: boolean;
  onText: (text: string) => void;
  /** What was dictated, to add to the end of the explanation. */
  onHeard: (heard: string) => void;
}) {
  const [dictateNotice, setDictateNotice] = useState<string | null>(null);
  return (
    <>
      <label class="learn-question muted" for="lesson-explain">
        Your explanation
      </label>
      <textarea
        id="lesson-explain"
        class="written"
        rows={4}
        value={text}
        readOnly={disabled}
        onInput={(event) => onText(event.currentTarget.value)}
      />
      <DictateButton
        serverDictation={serverDictation}
        disabled={disabled}
        onHeard={(heard) => {
          setDictateNotice(null);
          onHeard(heard);
        }}
        onNotice={setDictateNotice}
      />
      {dictateNotice ? <p class="muted">{dictateNotice}</p> : null}
    </>
  );
}

/** An explanation with what was dictated added to its end. */
function withDictated(text: string, heard: string): string {
  return text.trim() ? `${text.trimEnd()} ${heard}` : heard;
}

/** A lesson's sources, as further reading. */
export function ReadMore({ sources }: { sources: DeckLessonSource[] }) {
  return (
    <section class="lesson-sources" aria-labelledby="read-more-heading">
      <h3 id="read-more-heading" class="tracks-heading">
        Read more
      </h3>
      <ul class="lesson-source-list">
        {sources.map((source) => (
          <li key={source.url}>
            {isSafeHttpUrl(source.url) ? (
              <a href={source.url} target="_blank" rel="noopener noreferrer">
                {source.title}
              </a>
            ) : (
              <span>{source.title}</span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Teaches a lesson a step at a time: opening, unscored guesses, segments with diagrams and
 * predict-then-reveal checks, an explain-in-your-own-words step, and a recap. Progress stays on
 * the device so closing and returning carries on where the learner was. With `segmentIndex`,
 * shows just that segment and its check for a quick revisit, without recording a completion. A
 * lesson not yet done can be skipped with "I know this", by passing a short check instead.
 */
export function LessonScreen({
  itemKey,
  segmentIndex = null,
  autoStart = false,
  knowCheck = false,
  returnToTrack = null,
  serverDictation,
  onHome,
  onTrack,
}: {
  itemKey: string;
  /** Counting from 0, when revisiting a single segment from "Teach me" or after two lapses. */
  segmentIndex?: number | null;
  /** Skip the opening card when launched via "Start" on the flow's lesson card. */
  autoStart?: boolean;
  /** Start straight into "I know this", when launched from the flow's lesson card. */
  knowCheck?: boolean;
  /** Track to return to on finishing or going back, when opened from another track's flow. */
  returnToTrack?: TrackId | null;
  serverDictation: boolean;
  onHome: () => void;
  onTrack: (track: TrackId) => void;
}) {
  const state = useLearning();
  const deck = state.deck;
  const [tried, setTried] = useState(false);

  useEffect(() => {
    void state.sync().finally(() => setTried(true));
  }, []);

  const lesson = deck?.lessons?.find((l) => l.key === itemKey) ?? null;
  const backTrack = returnToTrack ?? lesson?.track ?? null;
  const trackInfo = backTrack ? deck?.tracks.find((t) => t.id === backTrack) : undefined;

  const header = (
    <header class="top">
      <span class="header-start">
        <HomeButton onHome={onHome} />
        {backTrack ? (
          <button type="button" class="text-button track-link" onClick={() => onTrack(backTrack)}>
            {trackInfo?.icon ? <TrackIcon icon={trackInfo.icon} size={16} /> : null}
            {trackInfo?.name ?? "Track"}
          </button>
        ) : (
          <TrackTitle title="Lesson" />
        )}
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
                "Opening a lesson offline needs this device to have been connected once, to fetch the deck."}
            </p>
          ) : (
            <p class="muted">Loading…</p>
          )}
        </main>
      </div>
    );
  }

  if (!lesson) {
    return (
      <div class="learn">
        {header}
        <main class="learn-content">
          <p class="error-text">There's no lesson called {itemKey}.</p>
          <button type="button" class="pill" onClick={onHome}>
            Home
          </button>
        </main>
      </div>
    );
  }

  const revisitSegment =
    segmentIndex !== null && segmentIndex >= 0 && segmentIndex < lesson.segments.length
      ? segmentIndex
      : null;

  return (
    <div class="learn">
      {header}
      {state.syncStatus.error ? (
        <div class="banner" role="alert">
          Couldn't sync: {state.syncStatus.error}. Your progress is kept on this device.
        </div>
      ) : null}
      <main class="learn-content">
        {revisitSegment !== null ? (
          <SingleSegmentBody
            key={`${lesson.key}:${revisitSegment}`}
            lesson={lesson}
            segmentIndex={revisitSegment}
            onDone={() => onTrack(returnToTrack ?? lesson.track)}
          />
        ) : (
          <LessonBody
            key={lesson.key}
            deck={deck}
            lesson={lesson}
            autoStart={autoStart}
            knowCheck={knowCheck}
            serverDictation={serverDictation}
            onTrack={() => onTrack(returnToTrack ?? lesson.track)}
          />
        )}
      </main>
    </div>
  );
}

/** Revisiting a single segment (and its check, if it has one) without adding a completion. */
function SingleSegmentBody({
  lesson,
  segmentIndex,
  onDone,
}: {
  lesson: DeckLesson;
  segmentIndex: number;
  onDone: () => void;
}) {
  const segment = lesson.segments[segmentIndex];
  const [chosen, setChosen] = useState<number | undefined>(undefined);
  if (!segment) return null;
  const canContinue = segment.check === null || chosen !== undefined;
  return (
    <article class="lesson-card" aria-label={segment.title}>
      <p class="lesson-step-label muted">
        {lesson.title} · Segment {segmentIndex + 1} of {lesson.segments.length}
      </p>
      <h2 class="lesson-segment-title">{segment.title}</h2>
      <LessonMarkdown text={segment.body} images={lesson.images} />
      {segment.check ? (
        <SegmentCheck
          check={segment.check}
          chosen={chosen}
          onChoose={(choice) => {
            if (chosen === undefined) setChosen(choice);
          }}
        />
      ) : null}
      {canContinue ? (
        <button type="button" class="pill primary wide" onClick={onDone}>
          Done
        </button>
      ) : null}
    </article>
  );
}

function LessonBody({
  deck,
  lesson,
  autoStart,
  knowCheck,
  serverDictation,
  onTrack,
}: {
  deck: Deck;
  lesson: DeckLesson;
  autoStart: boolean;
  knowCheck: boolean;
  serverDictation: boolean;
  onTrack: () => void;
}) {
  const state = useLearning();
  const online = useConnection();
  const [progress, setProgress] = useState<LessonProgress>(() => {
    const loaded = loadLessonProgress(lesson);
    if (knowCheck && loaded.knowCheck === null && offersKnowCheck(lesson)) {
      const started = beginKnowCheck(lesson, loaded);
      saveLessonProgress(lesson.key, started);
      return started;
    }
    if (autoStart && loaded.stage.kind === "opening") {
      const started = startLesson(lesson, loaded);
      saveLessonProgress(lesson.key, started);
      return started;
    }
    return loaded;
  });
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const openedAt = useRef(Date.now());
  const [aloudMode, setAloudMode] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);

  const knowStage = progress.knowCheck?.stage;
  const stageKey = knowStage
    ? `know:${knowStage.kind === "check" ? `check:${knowStage.index}` : knowStage.kind}`
    : progress.stage.kind === "guess" || progress.stage.kind === "segment"
      ? `${progress.stage.kind}:${progress.stage.index}`
      : progress.stage.kind;
  const previousStageKey = useRef(stageKey);
  useEffect(() => {
    if (previousStageKey.current !== stageKey) {
      previousStageKey.current = stageKey;
      window.scrollTo(0, 0);
    }
  }, [stageKey]);

  const elapsedNow = () => {
    const now = Date.now();
    const delta = Math.max(0, now - openedAt.current);
    openedAt.current = now;
    return (progressRef.current.elapsedMs ?? 0) + delta;
  };

  useEffect(() => {
    const persistElapsed = () => {
      const current = progressRef.current;
      if (current.stage.kind === "recap" || current.knowCheck?.stage.kind === "passed") return;
      const elapsedMs = elapsedNow();
      const updated = { ...current, elapsedMs };
      progressRef.current = updated;
      saveLessonProgress(lesson.key, updated);
    };
    window.addEventListener("pagehide", persistElapsed);
    return () => {
      window.removeEventListener("pagehide", persistElapsed);
      persistElapsed();
    };
  }, [lesson.key]);

  const update = (change: (current: LessonProgress) => LessonProgress) => {
    const elapsedMs = elapsedNow();
    const next = { ...change(progressRef.current), elapsedMs };
    progressRef.current = next;
    saveLessonProgress(lesson.key, next);
    setProgress(next);
  };

  const completed = completedLessons(deck, state.lessonCompletions);
  const unmet = unmetRequires(deck, lesson, completed);

  /** Moves on to where the lesson counts as done, recording its completion the first time. */
  const complete = (
    enter: (current: LessonProgress) => {
      next: LessonProgress;
      newlyCompletedId: string | null;
    },
  ) => {
    const durationMs = elapsedNow();
    const { next: entered, newlyCompletedId } = enter(progressRef.current);
    const next = { ...entered, elapsedMs: durationMs };
    progressRef.current = next;
    saveLessonProgress(lesson.key, next);
    setProgress(next);
    if (newlyCompletedId !== null) {
      learning().completeLesson({
        id: newlyCompletedId,
        lesson: lesson.key,
        completed_at: Date.now(),
        duration_ms: durationMs,
      });
    }
  };

  const goToRecap = () => complete((current) => enterRecap(current, newId));

  const finish = () => {
    clearLessonProgress(lesson.key);
    onTrack();
  };

  const done = (completed[lesson.key]?.length ?? 0) > 0;

  if (progress.knowCheck !== null) {
    const check = progress.knowCheck;
    return (
      <KnowCheckBody
        lesson={lesson}
        check={check}
        online={online}
        serverDictation={serverDictation}
        onChange={(change) => update((current) => updateKnowCheck(current, change))}
        onMarked={(marked) => {
          const current = progressRef.current.knowCheck;
          if (current === null) return;
          const next = markKnowCheck(lesson, current, marked);
          if (next.stage.kind === "passed") {
            complete((current) => stampCompletion({ ...current, knowCheck: next }, newId));
          } else {
            update((current) => ({ ...current, knowCheck: next }));
          }
        }}
        onLesson={() => update((current) => lessonAfterKnowCheck(lesson, current))}
        onNotNow={() => {
          state.skipLesson({ id: newId(), lesson: lesson.key, skipped_at: Date.now() });
          update((current) => ({ ...current, knowCheck: null }));
          onTrack();
        }}
        onDone={finish}
      />
    );
  }

  const markExplanation = () => {
    const text = progress.explainText;
    if (!text.trim()) return;
    setMarking(true);
    setMarkError(null);
    gradingApi
      .mark(lesson.key, newId(), "lesson", text, false)
      .then(
        (reply) => {
          update((current) => ({
            ...current,
            explainSpoken: false,
            marked: reply.marked,
            explainRevealed: true,
          }));
        },
        (e: unknown) => setMarkError(errorMessage(e)),
      )
      .finally(() => setMarking(false));
  };

  if (progress.stage.kind === "opening") {
    return (
      <article class="lesson-card" aria-label={lesson.title}>
        <div class="lesson-head">
          <p class="lesson-meta muted">~{lesson.minutes} min</p>
          <h2 class="lesson-title">{lesson.title}</h2>
          {unmet.length > 0 ? (
            <p class="lesson-requires-note muted">
              Lessons to do first: {unmet.map((u) => u.title).join(", ")}
            </p>
          ) : null}
        </div>
        <Markdown text={lesson.prompt} class="learn-prompt" />
        {!done && offersKnowCheck(lesson) ? (
          <div class="lesson-flow-actions">
            <button
              type="button"
              class="pill primary"
              onClick={() => update((current) => startLesson(lesson, current))}
            >
              Start
            </button>
            <button
              type="button"
              class="pill"
              onClick={() => update((current) => beginKnowCheck(lesson, current))}
            >
              I know this
            </button>
          </div>
        ) : (
          <button
            type="button"
            class="pill primary wide"
            onClick={() => update((current) => startLesson(lesson, current))}
          >
            Start
          </button>
        )}
      </article>
    );
  }

  if (progress.stage.kind === "guess") {
    const guessIndex = progress.stage.index;
    const guess = lesson.guesses[guessIndex];
    if (!guess) return null;
    return (
      <article class="lesson-card" aria-label="Guess">
        <p class="lesson-step-label muted">
          Guess {guessIndex + 1} of {lesson.guesses.length} · Answers come at the end
        </p>
        <Markdown text={guess.prompt} class="learn-prompt" />
        <ol class="learn-choices">
          {guess.choices.map((choice, choiceIndex) => (
            <li key={choice}>
              <button
                type="button"
                class="pill learn-choice"
                onClick={() =>
                  update((current) => answerGuess(lesson, current, guessIndex, choiceIndex))
                }
              >
                {choice}
              </button>
            </li>
          ))}
        </ol>
        <button
          type="button"
          class="pill learn-choice lesson-not-sure"
          onClick={() => update((current) => answerGuess(lesson, current, guessIndex, null))}
        >
          Not sure
        </button>
      </article>
    );
  }

  if (progress.stage.kind === "segment") {
    const segIndex = progress.stage.index;
    const segment = lesson.segments[segIndex];
    if (!segment) return null;
    const chosenCheck = progress.checks[segIndex];
    const checkAnswered = chosenCheck !== undefined;
    const canContinue = segment.check === null || checkAnswered;

    return (
      <article class="lesson-card" aria-label={segment.title}>
        <nav class="lesson-progress" aria-label="Lesson segments">
          <span class="lesson-progress-label muted">
            Segment {segIndex + 1} of {lesson.segments.length}
          </span>
          <ol class="lesson-progress-bars">
            {lesson.segments.map((seg, i) => {
              const reachable = i <= progress.reachedSegment;
              const barClass =
                i === segIndex ? "current" : i < segIndex ? "done" : reachable ? "reached" : "";
              return (
                <li key={seg.title}>
                  <button
                    type="button"
                    class={`lesson-progress-bar ${barClass}`}
                    aria-label={`Segment ${i + 1}: ${seg.title}`}
                    aria-current={i === segIndex ? "step" : undefined}
                    disabled={!reachable}
                    onClick={() => update((current) => goToSegment(lesson, current, i))}
                  />
                </li>
              );
            })}
          </ol>
        </nav>

        <h2 class="lesson-segment-title">{segment.title}</h2>
        <LessonMarkdown text={segment.body} images={lesson.images} />

        {segment.check ? (
          <SegmentCheck
            check={segment.check}
            chosen={chosenCheck}
            onChoose={(choiceIndex) =>
              update((current) => answerSegmentCheck(current, segIndex, choiceIndex))
            }
          />
        ) : null}

        <div class="lesson-nav">
          {segIndex > 0 ? (
            <button
              type="button"
              class="pill"
              onClick={() => update((current) => goToSegment(lesson, current, segIndex - 1))}
            >
              Previous
            </button>
          ) : null}
          {canContinue ? (
            <button
              type="button"
              class="pill primary lesson-continue"
              onClick={() => update((current) => advanceFromSegment(lesson, current, segIndex))}
            >
              Continue
            </button>
          ) : null}
        </div>
      </article>
    );
  }

  if (progress.stage.kind === "explain") {
    return (
      <article class="lesson-card" aria-label="Explain">
        <p class="lesson-step-label muted">Explain in your own words</p>
        <Markdown text={lesson.explain} class="learn-prompt" />

        {progress.explainRevealed ? (
          <>
            {progress.marked ? (
              <MarkedView marked={progress.marked} logMistakes={false} />
            ) : progress.explainText.trim() ? (
              <section class="lesson-your-answer" aria-label="Your explanation">
                <h3 class="tracks-heading">Your explanation</h3>
                <p class="learn-text">{progress.explainText}</p>
              </section>
            ) : null}
            <section class="learn-answer" aria-label="Explain answer">
              <h3 class="tracks-heading">Explain answer</h3>
              <Markdown text={lesson.explain_answer} />
            </section>
            <button type="button" class="pill primary wide" onClick={goToRecap}>
              Continue
            </button>
          </>
        ) : aloudMode ? (
          <>
            <ExplainAloud
              itemKey={lesson.key}
              work="lesson"
              question="Your explanation, explained aloud"
              serverDictation={serverDictation}
              onMarked={(reply, heard) => {
                update((current) => ({
                  ...current,
                  explainText: heard,
                  explainSpoken: true,
                  marked: reply.marked,
                  explainRevealed: true,
                }));
              }}
            />
            <span class="learn-links">
              <button type="button" class="learn-link" onClick={() => setAloudMode(false)}>
                Type it instead
              </button>
              <button
                type="button"
                class="learn-link"
                onClick={() => update((current) => ({ ...current, explainRevealed: true }))}
              >
                Compare with answer
              </button>
            </span>
          </>
        ) : (
          <form
            class="learn-form"
            onSubmit={(event) => {
              event.preventDefault();
              if (online) markExplanation();
              else update((current) => ({ ...current, explainRevealed: true }));
            }}
          >
            <ExplainInput
              text={progress.explainText}
              disabled={marking}
              serverDictation={serverDictation}
              onText={(text) => update((current) => ({ ...current, explainText: text }))}
              onHeard={(heard) =>
                update((current) => ({
                  ...current,
                  explainText: withDictated(current.explainText, heard),
                }))
              }
            />
            {markError ? (
              <p class="error-text" role="alert">
                {markError}
              </p>
            ) : null}
            {online ? (
              <div class="lesson-explain-actions">
                <button
                  type="submit"
                  class="pill primary wide"
                  disabled={marking || !progress.explainText.trim()}
                >
                  {marking ? "Marking…" : "Mark my explanation"}
                </button>
                <button
                  type="button"
                  class="pill wide"
                  disabled={marking}
                  onClick={() => update((current) => ({ ...current, explainRevealed: true }))}
                >
                  Compare with answer
                </button>
              </div>
            ) : (
              <>
                <button type="submit" class="pill primary wide">
                  Compare with answer
                </button>
                <p class="muted explain-hint">
                  Offline: compare your explanation with the answer instead of having it marked.
                </p>
              </>
            )}
            <span class="learn-links">
              <button
                type="button"
                class="learn-link"
                disabled={marking}
                onClick={() =>
                  update((current) => goToSegment(lesson, current, lesson.segments.length - 1))
                }
              >
                Back to segments
              </button>
              {online ? (
                <button
                  type="button"
                  class="learn-link"
                  disabled={marking}
                  onClick={() => setAloudMode(true)}
                >
                  Explain it aloud
                </button>
              ) : null}
            </span>
          </form>
        )}
      </article>
    );
  }

  return (
    <article class="lesson-card" aria-label="Recap">
      <div class="lesson-head">
        <h2 class="lesson-title">Recap</h2>
        <p class="lesson-meta muted">{lesson.title}</p>
      </div>

      {lesson.guesses.length > 0 ? (
        <section class="lesson-recap-guesses" aria-labelledby="recap-guesses-heading">
          <h3 id="recap-guesses-heading" class="tracks-heading">
            Your guesses
          </h3>
          <ol class="lesson-recap-list">
            {lesson.guesses.map((guess, i) => {
              const picked = progress.guesses[i];
              const gotIt = picked === guess.answer;
              const pickedText =
                picked === undefined || picked === null
                  ? "Not sure"
                  : (guess.choices[picked] ?? "Not sure");
              const rightText = guess.choices[guess.answer] ?? "";
              return (
                <li key={guess.prompt} class={`lesson-recap-guess ${gotIt ? "right" : ""}`}>
                  <Markdown text={guess.prompt} />
                  <p class="lesson-recap-picked muted">Your guess: {pickedText}</p>
                  <p class="lesson-recap-answer">Right answer: {rightText}</p>
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}

      <ReadMore sources={lesson.sources} />

      {lesson.source ? <p class="learn-source muted">Source: {lesson.source}</p> : null}

      <button type="button" class="pill primary wide" onClick={finish}>
        Done
      </button>
    </article>
  );
}

/**
 * "I know this": the lesson's checks one at a time, without the segments' text and with only
 * right or wrong shown, then its explain step marked by the grader. Passing counts the lesson as
 * done; otherwise it shows what was missed and offers the lesson.
 */
function KnowCheckBody({
  lesson,
  check,
  online,
  serverDictation,
  onChange,
  onMarked,
  onLesson,
  onNotNow,
  onDone,
}: {
  lesson: DeckLesson;
  check: KnowCheck;
  online: boolean;
  serverDictation: boolean;
  onChange: (change: (check: KnowCheck) => KnowCheck) => void;
  onMarked: (marked: Marked) => void;
  /** Leaves the check for the lesson itself. */
  onLesson: () => void;
  onNotNow: () => void;
  onDone: () => void;
}) {
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const stage = check.stage;
  const segments = checkedSegments(lesson);

  if (!online && (stage.kind === "check" || stage.kind === "explain")) {
    return (
      <article class="lesson-card" aria-label="I know this">
        <p class="lesson-step-label muted">I know this · {lesson.title}</p>
        <p class="lesson-know-offline" role="status">
          You're offline. Skipping a lesson needs the grader to mark your explanation, which needs a
          connection, so it can't be done offline.
        </p>
        <button type="button" class="pill primary wide" onClick={onLesson}>
          Do the lesson instead
        </button>
        <p class="muted explain-hint">Or come back online to carry on where you were.</p>
      </article>
    );
  }

  if (stage.kind === "check") {
    const segment = segments[stage.index];
    const segmentCheck = segment === undefined ? null : lesson.segments[segment]?.check;
    if (segment === undefined || !segmentCheck) return null;
    const chosen = check.answers[segment];
    return (
      <article class="lesson-card" aria-label="I know this">
        <p class="lesson-step-label muted">I know this · {lesson.title}</p>
        <SegmentCheck
          key={segment}
          check={segmentCheck}
          chosen={chosen}
          heading={`Check ${stage.index + 1} of ${segments.length}`}
          explain={false}
          onChoose={(choice) => onChange((current) => answerKnowCheck(lesson, current, choice))}
        />
        {chosen !== undefined ? (
          <button
            type="button"
            class="pill primary wide"
            onClick={() => onChange((current) => advanceKnowCheck(lesson, current))}
          >
            Continue
          </button>
        ) : null}
        <span class="learn-links">
          <button type="button" class="learn-link" onClick={onLesson}>
            Do the lesson instead
          </button>
        </span>
      </article>
    );
  }

  if (stage.kind === "explain") {
    const mark = () => {
      const text = check.explainText;
      if (!text.trim()) return;
      setMarking(true);
      setMarkError(null);
      gradingApi
        .mark(lesson.key, newId(), "lesson", text, false)
        .then(
          (reply) => onMarked(reply.marked),
          (e: unknown) => setMarkError(errorMessage(e)),
        )
        .finally(() => setMarking(false));
    };
    return (
      <article class="lesson-card" aria-label="I know this">
        <p class="lesson-step-label muted">I know this · Explain in your own words</p>
        <Markdown text={lesson.explain} class="learn-prompt" />
        <form
          class="learn-form"
          onSubmit={(event) => {
            event.preventDefault();
            mark();
          }}
        >
          <ExplainInput
            text={check.explainText}
            disabled={marking}
            serverDictation={serverDictation}
            onText={(text) => onChange((current) => ({ ...current, explainText: text }))}
            onHeard={(heard) =>
              onChange((current) => ({
                ...current,
                explainText: withDictated(current.explainText, heard),
              }))
            }
          />
          {markError ? (
            <p class="error-text" role="alert">
              {markError}
            </p>
          ) : null}
          <button
            type="submit"
            class="pill primary wide"
            disabled={marking || !check.explainText.trim()}
          >
            {marking ? "Marking…" : "Mark my explanation"}
          </button>
          <span class="learn-links">
            <button type="button" class="learn-link" disabled={marking} onClick={onLesson}>
              Do the lesson instead
            </button>
          </span>
        </form>
      </article>
    );
  }

  if (stage.kind === "passed") {
    return (
      <article class="lesson-card" aria-label="Lesson skipped">
        <div class="lesson-head">
          <h2 class="lesson-title">You know this</h2>
          <p class="lesson-meta muted">{lesson.title}</p>
        </div>
        <p class="lesson-know-result">
          You got every check right and explained it well, so the lesson's skipped and counts as
          done. Questions that wait for it start tomorrow.
        </p>
        {check.marked ? <KnowCheckMark marked={check.marked} /> : null}
        <section class="lesson-your-answer" aria-label="Your explanation">
          <h3 class="tracks-heading">Your explanation</h3>
          <p class="learn-text">{check.explainText}</p>
        </section>
        <section class="learn-answer" aria-label="Explain answer">
          <h3 class="tracks-heading">Explain answer</h3>
          <Markdown text={lesson.explain_answer} />
        </section>
        <ReadMore sources={lesson.sources} />
        <button type="button" class="pill primary wide" onClick={onDone}>
          Done
        </button>
      </article>
    );
  }

  const missed = missedSegments(lesson, check);
  return (
    <article class="lesson-card" aria-label="Not skipped">
      <div class="lesson-head">
        <h2 class="lesson-title">Worth doing the lesson</h2>
        <p class="lesson-meta muted">{lesson.title}</p>
      </div>
      <p class="lesson-know-result">
        {missed.length > 0
          ? "Not every check was right, so the lesson isn't skipped."
          : "Every check was right, but the explanation didn't cover enough to skip the lesson."}
      </p>
      {missed.length > 0 ? (
        <section class="lesson-know-missed" aria-labelledby="know-missed-heading">
          <h3 id="know-missed-heading" class="tracks-heading">
            {missed.length === 1 ? "A check you missed" : "Checks you missed"}
          </h3>
          <ol class="lesson-recap-list">
            {missed.map((segment) => {
              const segmentCheck = lesson.segments[segment]?.check;
              if (!segmentCheck) return null;
              const picked = check.answers[segment];
              return (
                <li key={segment} class="lesson-recap-guess">
                  <Markdown text={segmentCheck.prompt} />
                  <p class="lesson-recap-picked muted">
                    Your answer: {picked === undefined ? "" : segmentCheck.choices[picked]}
                  </p>
                  <p class="lesson-recap-answer">
                    Right answer: {segmentCheck.choices[segmentCheck.answer]}
                  </p>
                  <Markdown text={segmentCheck.explanation} class="muted" />
                </li>
              );
            })}
          </ol>
        </section>
      ) : null}
      {check.marked ? <KnowCheckMark marked={check.marked} /> : null}
      <div class="lesson-flow-actions">
        <button type="button" class="pill primary" onClick={onLesson}>
          Start the lesson
        </button>
        <button type="button" class="pill" onClick={onNotNow}>
          Not now
        </button>
      </div>
    </article>
  );
}

/** The grader's mark of an "I know this" explanation, briefly: its score and feedback. */
function KnowCheckMark({ marked }: { marked: Marked }) {
  return (
    <section class="lesson-know-mark" aria-label="Your explanation, marked">
      <h3 class="tracks-heading">Your explanation: {Math.round(marked.score * 100)}%</h3>
      <Markdown text={marked.feedback} />
    </section>
  );
}
