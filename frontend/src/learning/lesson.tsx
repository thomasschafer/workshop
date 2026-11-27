import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { gradingApi } from "../grading/api";
import { ExplainAloud } from "../grading/explain";
import { MarkedView } from "../grading/marked";
import { useConnection } from "../hooks/useConnection";
import { useMarkdown } from "../hooks/useMarkdown";
import { HomeButton, TrackTitle } from "../progress/page";
import { TrackIcon } from "../tracks/icons";
import type { TrackId } from "../tracks/types";
import { DictateButton } from "../views/dictate";
import "./lesson.css";
import { isSafeHttpUrl, renderLessonHtmlInto } from "./lessonMedia";
import {
  advanceFromSegment,
  answerGuess,
  answerSegmentCheck,
  clearLessonProgress,
  enterRecap,
  goToSegment,
  type LessonProgress,
  loadLessonProgress,
  saveLessonProgress,
  startLesson,
} from "./lessonState";
import { completedLessons, lessonsInTrack, newId, unmetRequires } from "./local";
import { Markdown, SyncChip, useLearning } from "./practice";
import { learning } from "./sync";
import type { Deck, DeckLesson, DeckLessonImage } from "./types";

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
  const renderedRef = useRef<{ html: string; images: Record<string, DeckLessonImage> } | null>(
    null,
  );

  useLayoutEffect(() => {
    const host = hostRef.current;
    if (!host || render === null) return;
    const html = render(text);
    if (renderedRef.current?.html === html && renderedRef.current.images === images) return;
    renderedRef.current = { html, images };
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

/**
 * Teaches a lesson a step at a time: opening, unscored guesses, segments with diagrams and
 * predict-then-reveal checks, an explain-in-your-own-words step, and a recap. Progress stays on
 * the device so closing and returning carries on where the learner was.
 */
export function LessonScreen({
  itemKey,
  serverDictation,
  onHome,
  onTrack,
}: {
  itemKey: string;
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
  const trackInfo = lesson ? deck?.tracks.find((t) => t.id === lesson.track) : undefined;

  const header = (
    <header class="top">
      <span class="header-start">
        <HomeButton onHome={onHome} />
        {lesson ? (
          <button
            type="button"
            class="text-button track-link"
            onClick={() => onTrack(lesson.track)}
          >
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

  return (
    <div class="learn">
      {header}
      {state.syncStatus.error ? (
        <div class="banner" role="alert">
          Couldn't sync: {state.syncStatus.error}. Your progress is kept on this device.
        </div>
      ) : null}
      <main class="learn-content">
        <LessonBody
          key={lesson.key}
          deck={deck}
          lesson={lesson}
          serverDictation={serverDictation}
          onTrack={onTrack}
        />
      </main>
    </div>
  );
}

function LessonBody({
  deck,
  lesson,
  serverDictation,
  onTrack,
}: {
  deck: Deck;
  lesson: DeckLesson;
  serverDictation: boolean;
  onTrack: (track: TrackId) => void;
}) {
  const state = useLearning();
  const online = useConnection();
  const [progress, setProgress] = useState<LessonProgress>(() => loadLessonProgress(lesson));
  const progressRef = useRef(progress);
  progressRef.current = progress;
  const [aloudMode, setAloudMode] = useState(false);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [dictateNotice, setDictateNotice] = useState<string | null>(null);

  const stageKey =
    progress.stage.kind === "guess" || progress.stage.kind === "segment"
      ? `${progress.stage.kind}:${progress.stage.index}`
      : progress.stage.kind;
  const previousStageKey = useRef(stageKey);
  useEffect(() => {
    if (previousStageKey.current !== stageKey) {
      previousStageKey.current = stageKey;
      window.scrollTo(0, 0);
    }
  }, [stageKey]);

  const update = (change: (current: LessonProgress) => LessonProgress) => {
    const next = change(progressRef.current);
    progressRef.current = next;
    saveLessonProgress(lesson.key, next);
    setProgress(next);
  };

  const completed = completedLessons(deck, state.lessonCompletions);
  const unmet = unmetRequires(deck, lesson, completed);

  const goToRecap = () => {
    const { next, newlyCompletedId } = enterRecap(progressRef.current, newId);
    progressRef.current = next;
    saveLessonProgress(lesson.key, next);
    setProgress(next);
    if (newlyCompletedId !== null) {
      learning().completeLesson({
        id: newlyCompletedId,
        lesson: lesson.key,
        completed_at: Date.now(),
      });
    }
  };

  const finish = () => {
    clearLessonProgress(lesson.key);
    onTrack(lesson.track);
  };

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
        <button
          type="button"
          class="pill primary wide"
          onClick={() => update((current) => startLesson(lesson, current))}
        >
          Start
        </button>
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
          <section class="lesson-check" aria-label="Check">
            <h3 class="tracks-heading">Check</h3>
            <Markdown text={segment.check.prompt} />
            <ol class="learn-choices">
              {segment.check.choices.map((choice, choiceIndex) => {
                const choiceClass = !checkAnswered
                  ? ""
                  : choiceIndex === segment.check?.answer
                    ? "right"
                    : choiceIndex === chosenCheck
                      ? "wrong"
                      : "";
                return (
                  <li key={choice}>
                    <button
                      type="button"
                      class={`pill learn-choice ${choiceClass}`}
                      aria-pressed={chosenCheck === choiceIndex}
                      disabled={checkAnswered}
                      onClick={() =>
                        update((current) => answerSegmentCheck(current, segIndex, choiceIndex))
                      }
                    >
                      {choice}
                    </button>
                  </li>
                );
              })}
            </ol>
            {checkAnswered ? (
              <section
                class={`learn-answer ${chosenCheck === segment.check.answer ? "right" : "wrong"}`}
                aria-label="Explanation"
              >
                <p class="learn-verdict">
                  {chosenCheck === segment.check.answer
                    ? "Right"
                    : `It's: ${segment.check.choices[segment.check.answer]}`}
                </p>
                <Markdown text={segment.check.explanation} class="muted" />
              </section>
            ) : null}
          </section>
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
            <label class="learn-question muted" for="lesson-explain">
              Your explanation
            </label>
            <textarea
              id="lesson-explain"
              class="written"
              rows={4}
              value={progress.explainText}
              readOnly={marking}
              onInput={(event) => {
                const text = event.currentTarget.value;
                update((current) => ({ ...current, explainText: text }));
              }}
            />
            <DictateButton
              serverDictation={serverDictation}
              disabled={marking}
              onHeard={(heard) => {
                setDictateNotice(null);
                update((current) => ({
                  ...current,
                  explainText: current.explainText.trim()
                    ? `${current.explainText.trimEnd()} ${heard}`
                    : heard,
                }));
              }}
              onNotice={setDictateNotice}
            />
            {dictateNotice ? <p class="muted">{dictateNotice}</p> : null}
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

      <section class="lesson-sources" aria-labelledby="read-more-heading">
        <h3 id="read-more-heading" class="tracks-heading">
          Read more
        </h3>
        <ul class="lesson-source-list">
          {lesson.sources.map((source) => (
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

      {lesson.source ? <p class="learn-source muted">Source: {lesson.source}</p> : null}

      <button type="button" class="pill primary wide" onClick={finish}>
        Done
      </button>
    </article>
  );
}
