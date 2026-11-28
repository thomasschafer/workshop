import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { ReadMore } from "../learning/lesson";
import { newId } from "../learning/local";
import { Markdown } from "../learning/practice";
import { Loading, Page } from "../progress/page";
import { LatestSaver } from "../saver";
import { DictateButton } from "../views/dictate";
import { StepNav } from "../views/steps";
import { gradingApi } from "./api";
import { splitCodeBlocks } from "./codeBlocks";
import { labEditsInTurn } from "./labEdits";
import { MarkedView, MET } from "./marked";
import type { LabEdit, LabMarked, LabOpened, LabSession } from "./types";

/** How long typing pauses before it's saved. */
const SAVE_DELAY_MS = 600;

/** What labs need, said wherever one can't be worked on offline. */
const NEEDS_SERVER =
  "Labs need the server, which can't be reached. What you've recorded is kept there; carry on once it can be.";

/** Changes made on this device that the server hasn't confirmed yet, such as while offline. */
interface Unsaved {
  edit: LabEdit;
  at: number;
}

const unsavedKey = (key: string) => `workshop:unsaved:lab:${key}`;

function readUnsaved(key: string): Unsaved | null {
  try {
    const raw = localStorage.getItem(unsavedKey(key));
    return raw ? (JSON.parse(raw) as Unsaved) : null;
  } catch {
    return null;
  }
}

function writeUnsaved(key: string, unsaved: Unsaved | null): void {
  try {
    if (unsaved === null) localStorage.removeItem(unsavedKey(key));
    else localStorage.setItem(unsavedKey(key), JSON.stringify(unsaved));
  } catch {
    // Storage can be full or disabled; the server save is still attempted.
  }
}

function editOf(session: LabSession): LabEdit {
  return { at: session.at, records: session.records, explanation: session.explanation };
}

/** A lab, as `pack/item`: what it is and how to start, or the learner's session with it. */
export function LabScreen({
  itemKey,
  serverDictation,
  onHome,
  onBack,
  onOpenLesson,
}: {
  itemKey: string;
  serverDictation: boolean;
  onHome: () => void;
  /** Leaves the lab, back to where it was opened from. */
  onBack: () => void;
  onOpenLesson: (key: string) => void;
}) {
  const online = useConnection();
  const [opened, setOpened] = useState<LabOpened | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [starting, setStarting] = useState(false);
  useEffect(() => {
    if (!online || opened) return;
    setError(null);
    gradingApi.lab(itemKey).then(setOpened, (e: unknown) => setError(errorMessage(e)));
  }, [attempt, online]);

  const start = (again = false) => {
    setStarting(true);
    setError(null);
    gradingApi
      .startLab(itemKey, again)
      .then(
        (started) => {
          writeUnsaved(itemKey, null);
          setOpened(started);
        },
        (e: unknown) => setError(errorMessage(e)),
      )
      .finally(() => setStarting(false));
  };

  if (opened === null) {
    return (
      <Page title="Lab" icon="flask" onHome={onHome}>
        {online ? (
          <Loading error={error} onRetry={() => setAttempt((n) => n + 1)} />
        ) : (
          <p class="banner offline" role="status">
            {NEEDS_SERVER}
          </p>
        )}
      </Page>
    );
  }
  const lesson = opened.lesson;
  return (
    <Page title="Lab" icon="flask" onHome={onHome}>
      {opened.session?.stale ? (
        <section class="lab-intro" aria-label="Lab">
          <h2 class="lab-title">{opened.label}</h2>
          <p role="alert">
            This lab's steps have changed since you started it, so what you recorded no longer fits
            them. Start it again to carry on.
          </p>
          {error ? <p class="error-text">{error}</p> : null}
          <span class="learn-actions">
            <button type="button" class="pill" onClick={onBack}>
              Later
            </button>
            <button
              type="button"
              class="pill primary"
              disabled={starting || !online}
              onClick={() => start(true)}
            >
              Start it again
            </button>
          </span>
        </section>
      ) : opened.session ? (
        <LabSessionView
          key={opened.session.started_at}
          opened={opened}
          session={opened.session}
          serverDictation={serverDictation}
          onDone={onBack}
        />
      ) : (
        <section class="lab-intro" aria-label="Lab">
          <h2 class="lab-title">{opened.label}</h2>
          <p class="lab-meta muted">
            Lab · about {opened.minutes} minutes · {opened.steps.length}{" "}
            {opened.steps.length === 1 ? "step" : "steps"}
          </p>
          <Markdown text={opened.prompt} class="learn-prompt" />
          {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
          {lesson && !lesson.done ? (
            <p class="lab-lesson">
              It builds on the lesson{" "}
              <button
                type="button"
                class="text-button inline"
                onClick={() => onOpenLesson(lesson.key)}
              >
                {lesson.title}
              </button>
              , so do that first.
            </p>
          ) : null}
          <p class="muted">
            You carry a lab out on a machine of your own, a step at a time, and record what you ran
            and saw at each. At the end, it's marked against what each step should show, which you
            see then. Everything's saved as you write, so you can stop and carry on later, here or
            on another device.
          </p>
          {!online ? (
            <p class="banner offline" role="status">
              {NEEDS_SERVER}
            </p>
          ) : null}
          {error ? (
            <p class="error-text" role="alert">
              {error}
            </p>
          ) : null}
          <span class="learn-actions">
            <button type="button" class="pill" onClick={onBack}>
              Later
            </button>
            <button
              type="button"
              class="pill primary"
              disabled={starting || !online}
              onClick={() => start()}
            >
              Start the lab
            </button>
          </span>
          {opened.previous ? (
            <details>
              <summary class="muted">What you recorded last time</summary>
              <Markdown text={opened.previous} />
            </details>
          ) : null}
        </section>
      )}
    </Page>
  );
}

/** Markdown with a button to copy each of its code blocks, such as commands to run. */
function CopyableMarkdown({ text }: { text: string }) {
  return (
    <div class="lab-text">
      {splitCodeBlocks(text).map((part, i) =>
        part.kind === "text" ? (
          // A part is its place in the text, which doesn't change while it's shown.
          <Markdown key={i} text={part.text} />
        ) : (
          <CodeBlock key={i} markdown={part.markdown} code={part.code} />
        ),
      )}
    </div>
  );
}

function CodeBlock({ markdown, code }: { markdown: string; code: string }) {
  const [copied, setCopied] = useState<"copied" | "failed" | null>(null);
  const copy = () => {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (!clipboard) {
      setCopied("failed");
      return;
    }
    clipboard.writeText(code).then(
      () => setCopied("copied"),
      () => setCopied("failed"),
    );
  };
  return (
    <div class="lab-code">
      <Markdown text={markdown} />
      <span class="lab-copy">
        <button type="button" class="pill" onClick={copy}>
          Copy
        </button>
        {copied ? (
          <span class="muted" role="status">
            {copied === "copied" ? "Copied" : "Couldn't copy: select the text instead"}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/**
 * A lab under way, a screen at a time: its setup, each step with a box for what the learner ran
 * and saw, then the question at the end. Everything's saved on the server as it's written, so
 * it can be left at any screen and carried on later, and the grader marks the whole lab at the
 * end.
 */
function LabSessionView({
  opened,
  session: initial,
  serverDictation,
  onDone,
}: {
  opened: LabOpened;
  session: LabSession;
  serverDictation: boolean;
  onDone: () => void;
}) {
  const key = opened.key;
  const steps = opened.steps;
  const explainAt = steps.length + 1;
  const online = useConnection();
  // How far the server has the session, for saves to know which screens it's reached.
  const savedRef = useRef(initial);
  const [edit, setEdit] = useState<LabEdit>(() => {
    // What was done here while the server couldn't hear of it wins over what it has.
    const unsaved = readUnsaved(key);
    return unsaved &&
      unsaved.at > initial.updated_at &&
      unsaved.edit.records.length === steps.length
      ? unsaved.edit
      : editOf(initial);
  });
  const editRef = useRef(edit);
  // The furthest screen reached here, which the server may not have heard of yet.
  const [reached, setReached] = useState(() => Math.max(initial.reached, edit.at));
  const reachedRef = useRef(reached);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [marking, setMarking] = useState(false);
  const [markError, setMarkError] = useState<string | null>(null);
  const [result, setResult] = useState<LabMarked | null>(null);

  const saver = useMemo(
    () =>
      new LatestSaver<LabEdit>(
        async (next, keepalive) => {
          let saved = savedRef.current;
          for (const step of labEditsInTurn(next, saved.reached, reachedRef.current)) {
            saved = await gradingApi.saveLab(key, step, keepalive);
            savedRef.current = saved;
          }
          if (JSON.stringify(editRef.current) === JSON.stringify(next)) writeUnsaved(key, null);
          setSaveError(null);
        },
        SAVE_DELAY_MS,
        setSaveError,
      ),
    [key],
  );
  useEffect(() => {
    // Changes kept on the device from before are sent as soon as it opens.
    if (readUnsaved(key)) saver.schedule(editRef.current);
    const leave = () => saver.flushOnExit();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [saver]);

  const change = (update: (edit: LabEdit) => LabEdit, now = false): Promise<void> => {
    const next = update(editRef.current);
    editRef.current = next;
    setEdit(next);
    reachedRef.current = Math.max(reachedRef.current, next.at);
    setReached(reachedRef.current);
    writeUnsaved(key, { edit: next, at: Date.now() });
    saver.schedule(next);
    return now ? saver.flush().catch(() => {}) : Promise.resolve();
  };

  const goTo = (at: number) => {
    setNotice(null);
    void change((e) => ({ ...e, at }), true);
    window.scrollTo(0, 0);
  };

  const finish = async () => {
    setMarking(true);
    setMarkError(null);
    try {
      await saver.flush();
      const marked = await gradingApi.finishLab(key, newId());
      writeUnsaved(key, null);
      setResult(marked);
      window.scrollTo(0, 0);
    } catch (e) {
      setMarkError(errorMessage(e));
    } finally {
      setMarking(false);
    }
  };

  if (result) return <LabResult result={result} onDone={onDone} />;

  const at = edit.at;
  const screens = Array.from({ length: explainAt + 1 }, (_, i) => String(i));
  const screenName = (i: number) =>
    i === 0 ? "the setup" : i === explainAt ? "the question at the end" : `step ${i}`;
  const step = at >= 1 && at <= steps.length ? steps[at - 1] : null;
  const record = step ? (edit.records[at - 1] ?? "") : "";
  const recordedAny = edit.records.some((r) => r.trim());

  const setRecord = (text: string) =>
    change((e) => ({ ...e, records: e.records.map((r, i) => (i === at - 1 ? text : r)) }));
  const addHeard = (before: string, heard: string) =>
    before.trim() ? `${before.replace(/\s*$/, "")}\n${heard}` : heard;

  return (
    <>
      <StepNav
        title={opened.label}
        steps={screens}
        current={String(at)}
        label={(id) => (id === "0" ? "Setup" : id === String(explainAt) ? "Explain" : id)}
        reachable={(id) => Number(id) <= reached}
        onGo={(id) => goTo(Number(id))}
      />
      <details class="coding-statement" open={at === 0}>
        <summary>What it's about</summary>
        <Markdown text={opened.prompt} class="learn-prompt" />
      </details>
      {at === 0 ? (
        <section class="lab-screen" aria-label="Setup">
          <h2 class="lab-screen-name">Setup</h2>
          <CopyableMarkdown text={opened.setup} />
        </section>
      ) : step ? (
        <section class="lab-screen" aria-label={`Step ${at}`}>
          <h2 class="lab-screen-name">
            Step {at} of {steps.length}: {step.title}
          </h2>
          <CopyableMarkdown text={step.body} />
          <label class="learn-question" for="lab-record">
            What you ran and saw
          </label>
          <textarea
            id="lab-record"
            class="written lab-record"
            value={record}
            placeholder="Paste or type the commands you ran, and what they printed."
            onInput={(event) => void setRecord(event.currentTarget.value)}
          />
          <DictateButton
            serverDictation={serverDictation}
            onHeard={(heard) => {
              void change(
                (e) => ({
                  ...e,
                  records: e.records.map((r, i) => (i === at - 1 ? addHeard(r, heard) : r)),
                }),
                true,
              );
            }}
            onNotice={setNotice}
          />
        </section>
      ) : (
        <section class="lab-screen" aria-label="The question at the end">
          <h2 class="lab-screen-name">The question at the end</h2>
          <Markdown text={opened.explain} />
          <label class="learn-question" for="lab-explanation">
            Your answer, in your own words
          </label>
          <textarea
            id="lab-explanation"
            class="written"
            value={edit.explanation}
            onInput={(event) => {
              const text = event.currentTarget.value;
              void change((e) => ({ ...e, explanation: text }));
            }}
          />
          <DictateButton
            serverDictation={serverDictation}
            onHeard={(heard) => {
              void change((e) => ({ ...e, explanation: addHeard(e.explanation, heard) }), true);
            }}
            onNotice={setNotice}
          />
        </section>
      )}
      {notice ? <p class="muted">{notice}</p> : null}
      {saveError ? (
        <p class="muted" role="status">
          Not saved yet: {saveError}. It's kept on this device, and saved once the server can be
          reached.
        </p>
      ) : null}
      {!online ? (
        <p class="banner offline" role="status">
          {NEEDS_SERVER}
        </p>
      ) : null}
      {markError ? (
        <p class="error-text" role="alert">
          {markError}
        </p>
      ) : null}
      <span class="learn-actions">
        {at > 0 ? (
          <button type="button" class="pill" onClick={() => goTo(at - 1)}>
            Back
          </button>
        ) : (
          <button type="button" class="pill" onClick={onDone}>
            Stop here for now
          </button>
        )}
        {at < explainAt ? (
          <button type="button" class="pill primary" onClick={() => goTo(at + 1)}>
            Next: {screenName(at + 1)}
          </button>
        ) : (
          <button
            type="button"
            class="pill primary"
            disabled={marking || !online || !recordedAny || !edit.explanation.trim()}
            onClick={() => void finish()}
          >
            {marking ? "Marking…" : "Finish and mark it"}
          </button>
        )}
      </span>
      {at > 0 ? (
        <button type="button" class="text-button lab-stop" onClick={onDone}>
          Stop here for now
        </button>
      ) : null}
    </>
  );
}

/** A lab once it's marked: the overall marks, then each step's expected result beside what was
 * recorded, and the question at the end's good answer beside the learner's. */
function LabResult({ result, onDone }: { result: LabMarked; onDone: () => void }) {
  return (
    <>
      <h2 class="lab-screen-name">Marked</h2>
      <MarkedView marked={result.marked} showPoints={false} />
      <ol class="lab-results">
        {result.steps.map((step, i) => (
          <li key={step.title} class={`lab-result marked-point ${step.point.met}`}>
            <h3 class="lab-result-name">
              Step {i + 1}: {step.title}
            </h3>
            <p class="marked-met">{MET[step.point.met]}</p>
            {step.point.comment ? <p class="muted">{step.point.comment}</p> : null}
            <h4 class="tracks-heading">What it should show</h4>
            <Markdown text={step.expected} />
            <h4 class="tracks-heading">What you recorded</h4>
            {step.recorded ? (
              <pre class="lab-recorded">{step.recorded}</pre>
            ) : (
              <p class="muted">Nothing recorded.</p>
            )}
          </li>
        ))}
        <li class={`lab-result marked-point ${result.explain.point.met}`}>
          <h3 class="lab-result-name">The question at the end</h3>
          <Markdown text={result.explain.question} />
          <p class="marked-met">{MET[result.explain.point.met]}</p>
          {result.explain.point.comment ? (
            <p class="muted">{result.explain.point.comment}</p>
          ) : null}
          <h4 class="tracks-heading">What a good answer covers</h4>
          <Markdown text={result.explain.answer} />
          <h4 class="tracks-heading">Your answer</h4>
          <p class="lab-given">{result.explain.given}</p>
        </li>
      </ol>
      <ReadMore sources={result.sources} />
      <button type="button" class="pill primary wide" onClick={onDone}>
        Done
      </button>
    </>
  );
}
