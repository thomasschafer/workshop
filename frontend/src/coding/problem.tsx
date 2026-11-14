import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { Bootstrap } from "../api";
import type { CodeEditor } from "../editor";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { useConversation } from "../hooks/useConversation";
import { useEditorSettings } from "../hooks/useEditorSettings";
import { newId } from "../learning/local";
import { sameOutput } from "../learning/output";
import { Markdown } from "../learning/practice";
import type { Rating } from "../learning/types";
import { LatestSaver, type VersionedSaver } from "../saver";
import { Keyboard } from "../views/keyboard";
import { codingApi } from "./api";
import { DictateButton } from "./dictate";
import { EditorPane } from "./editorPane";
import {
  describeCase,
  describeRun,
  reached,
  STEP_LABELS,
  stepAfter,
  stepsFor,
  suggestedRating,
} from "./steps";
import { TutorSheet } from "./tutor";
import type { CaseResult, Graded, Opened, Session, StepName, Submitted } from "./types";

/** How long typing in the plan pauses before it's saved. */
const SAVE_DELAY_MS = 600;

/** A session saved on this device that the server hasn't confirmed yet, such as while offline. */
interface Unsaved {
  session: Session;
  at: number;
}

const unsavedKey = (key: string) => `workshop:unsaved:coding-session:${key}`;

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

/**
 * A coding problem, in steps of a few minutes: understand it, plan, code, test and review, or
 * for one solved before, recall the plan and review it. Each step is saved as it goes, so the
 * learner can stop at any moment, and opening it again carries on where they were.
 */
export function ProblemView({
  boot,
  itemKey,
  onHome,
  onList,
}: {
  boot: Bootstrap;
  itemKey: string;
  onHome: () => void;
  onList: () => void;
}) {
  const online = useConnection();
  const [opened, setOpened] = useState<Opened | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [tutorOpen, setTutorOpen] = useState(false);
  const [finished, setFinished] = useState<{ due: number | null } | null>(null);

  const saver = useMemo(
    () =>
      new LatestSaver<Session>(
        async (next, keepalive) => {
          const saved = await codingApi.saveSession(itemKey, next, keepalive);
          // Only what's still unsaved is forgotten: a later change waits its turn.
          if (JSON.stringify(readUnsaved(itemKey)?.session) === JSON.stringify(next)) {
            writeUnsaved(itemKey, null);
          }
          setOpened((current) => (current ? { ...current, solution: saved.solution } : saved));
        },
        SAVE_DELAY_MS,
        () => {},
      ),
    [itemKey],
  );
  useEffect(() => {
    const leave = () => saver.flushOnExit();
    window.addEventListener("pagehide", leave);
    return () => {
      window.removeEventListener("pagehide", leave);
      leave();
    };
  }, [saver]);

  /** Changes the session, saving it on the device now and on the server shortly. */
  const change = useCallback(
    (update: (session: Session) => Session, now = false): Promise<void> => {
      const current = sessionRef.current;
      if (!current) return Promise.resolve();
      const next = update(current);
      sessionRef.current = next;
      setSession(next);
      writeUnsaved(itemKey, { session: next, at: Date.now() });
      saver.schedule(next);
      return now ? saver.flush().catch(() => {}) : Promise.resolve();
    },
    [itemKey, saver],
  );

  const load = useCallback(
    async (solve = false) => {
      setError(null);
      setFinished(null);
      try {
        const fresh = await codingApi.open(itemKey, solve);
        // What was done here while the server couldn't hear of it wins over what it has.
        const unsaved = solve ? null : readUnsaved(itemKey);
        const adopted =
          unsaved &&
          unsaved.at > fresh.session.updated_at &&
          unsaved.session.mode === fresh.session.mode
            ? unsaved.session
            : fresh.session;
        if (adopted !== fresh.session) saver.schedule(adopted);
        else writeUnsaved(itemKey, null);
        setOpened(fresh);
        sessionRef.current = adopted;
        setSession(adopted);
      } catch (e) {
        setError(errorMessage(e));
      }
    },
    [itemKey, saver],
  );
  useEffect(() => {
    void load();
  }, [load]);

  // Once it's being reviewed, the solution comes with the session's save.
  useEffect(() => {
    if (session?.step === "review" && opened && opened.solution === null && online) {
      void saver.flush().catch(() => {});
    }
  }, [session?.step, opened?.solution, online]);

  const models = boot.models.discuss_models;
  const [model, setModel] = useState(
    boot.state.discuss_model && models.includes(boot.state.discuss_model)
      ? boot.state.discuss_model
      : (models[0] ?? ""),
  );
  const editor = useRef<CodeEditor | null>(null);
  const draftSaver = useRef<VersionedSaver | null>(null);
  const lastRun = useRef("");
  const tutor = useConversation(
    `workshop:tutor:${itemKey}`,
    (turns, onDelta) => {
      change((s) => ({ ...s, hints: s.hints + 1 }));
      return codingApi.tutor(
        itemKey,
        {
          model,
          turns,
          code: editor.current?.text() ?? "",
          errors: editor.current?.diagnosticsText() ?? "",
          last_run: lastRun.current,
        },
        onDelta,
      );
    },
    "Open a problem before asking about it.",
  );

  const header = (
    <header class="top">
      <span class="header-start">
        <button type="button" class="icon-button home-button" aria-label="Home" onClick={onHome}>
          ⌂
        </button>
        <button type="button" class="text-button" onClick={onList}>
          Coding
        </button>
      </span>
      {online ? null : (
        <span class="learn-sync offline" role="status">
          Offline
        </span>
      )}
    </header>
  );

  if (error && !opened) {
    return (
      <div class="learn">
        {header}
        <main class="learn-content">
          <p class="error-text">
            {online
              ? error
              : "Coding problems need the server, which can't be reached. Code to read works offline, from the Coding list."}
          </p>
          <button type="button" class="pill" onClick={() => void load()}>
            Try again
          </button>
        </main>
      </div>
    );
  }
  if (!opened || !session) {
    return (
      <div class="learn">
        {header}
        <main class="learn-content">
          <p class="muted">Loading…</p>
        </main>
      </div>
    );
  }

  const goTo = (step: StepName) => change((s) => ({ ...s, step }), true);
  const next = () => {
    const after = stepAfter(session.mode, session.step);
    if (after) goTo(after);
  };
  const giveUp = () => change((s) => ({ ...s, step: "review" }), true);

  const steps = stepsFor(session.mode);
  const offlineBanner = online ? null : (
    <div class="banner offline" role="status">
      Can't reach the server. Running code and the tutor need it; what you do here is kept, and
      saved once it's back.
    </div>
  );
  const shared = {
    opened,
    session,
    change,
    online,
    openTutor: () => setTutorOpen(true),
    notify: setNotice,
  };

  const body = finished ? (
    <Finished
      due={finished.due}
      mode={session.mode}
      onHome={onHome}
      onList={onList}
      onSolve={() => void load(true)}
    />
  ) : session.step === "understand" ? (
    <UnderstandStep {...shared} onNext={next} />
  ) : session.step === "plan" ? (
    <PlanStep
      {...shared}
      boot={boot}
      onNext={next}
      onSolve={session.mode === "recall" ? () => void load(true) : null}
    />
  ) : session.step === "code" || session.step === "test" ? (
    <CodeStep
      {...shared}
      boot={boot}
      itemKey={itemKey}
      editor={editor}
      draftSaver={draftSaver}
      onRan={(summary) => {
        lastRun.current = summary;
      }}
      onReloaded={(fresh) => {
        setOpened(fresh);
        sessionRef.current = fresh.session;
        setSession(fresh.session);
        writeUnsaved(itemKey, null);
      }}
      onGiveUp={giveUp}
    />
  ) : (
    <ReviewStep
      {...shared}
      onFinish={async (rating) => {
        await saver.flush();
        const done = await codingApi.finish(itemKey, newId(), rating);
        writeUnsaved(itemKey, null);
        setFinished(done);
      }}
    />
  );

  return (
    <div
      class={`learn coding-problem ${session.step === "code" || session.step === "test" ? "coding-at-code" : ""}`}
    >
      {header}
      <nav class="coding-steps" aria-label="Steps">
        <h1 class="coding-title">{opened.label}</h1>
        <ol>
          {steps.map((step) => (
            <li key={step}>
              <button
                type="button"
                class={`coding-step ${step === session.step ? "current" : ""}`}
                aria-current={step === session.step ? "step" : undefined}
                disabled={!reached(session.mode, session.step, step) || finished !== null}
                onClick={() => goTo(step)}
              >
                {STEP_LABELS[step]}
              </button>
            </li>
          ))}
        </ol>
      </nav>
      {offlineBanner}
      {notice ? (
        <div class="banner" role="status">
          <span>{notice}</span>
          <button type="button" class="text-button" onClick={() => setNotice(null)}>
            OK
          </button>
        </div>
      ) : null}
      {body}
      {tutorOpen ? (
        <TutorSheet
          conversation={tutor}
          models={models}
          model={model}
          onModel={setModel}
          online={online}
          onClose={() => setTutorOpen(false)}
        />
      ) : null}
    </div>
  );
}

interface StepProps {
  opened: Opened;
  session: Session;
  /** Changes the session; with `now`, saves it straight away, settling once it's tried. */
  change: (update: (session: Session) => Session, now?: boolean) => Promise<void>;
  online: boolean;
  openTutor: () => void;
  notify: (text: string) => void;
}

function TutorButton({ online, openTutor }: Pick<StepProps, "online" | "openTutor">) {
  return (
    <button type="button" class="pill" onClick={openTutor} disabled={!online}>
      {online ? "Ask the tutor" : "Tutor needs the server"}
    </button>
  );
}

function Statement({ opened, open = true }: { opened: Opened; open?: boolean }) {
  return (
    <details class="coding-statement" open={open}>
      <summary>The problem</summary>
      <Markdown text={opened.prompt} class="learn-prompt" />
      {opened.source ? <p class="learn-source muted">Source: {opened.source}</p> : null}
    </details>
  );
}

/** Understanding the problem: working out by hand what the first example prints. */
function UnderstandStep({ opened, session, change, onNext }: StepProps & { onNext: () => void }) {
  const example = opened.examples[0];
  const [prediction, setPrediction] = useState(session.prediction ?? "");
  const [checked, setChecked] = useState<boolean | null>(
    session.prediction !== null && example ? sameOutput(example.output, session.prediction) : null,
  );
  if (!example) return null;
  return (
    <main class="learn-content">
      <Markdown text={opened.prompt} class="learn-prompt" />
      <section class="coding-example" aria-label="Example 1">
        <h2 class="coding-subheading">For this input</h2>
        <pre class="coding-io">{example.input}</pre>
      </section>
      <form
        class="learn-form"
        onSubmit={(event) => {
          event.preventDefault();
          setChecked(sameOutput(example.output, prediction));
          change((s) => ({ ...s, prediction }), true);
        }}
      >
        <label class="learn-question" for="coding-prediction">
          What should it print?
        </label>
        <textarea
          id="coding-prediction"
          class="learn-output"
          rows={2}
          autoComplete="off"
          autoCorrect="off"
          spellcheck={false}
          value={prediction}
          onInput={(event) => {
            setPrediction(event.currentTarget.value);
            setChecked(null);
          }}
        />
        {checked === null ? (
          <span class="learn-actions">
            <button type="button" class="pill" onClick={onNext}>
              Skip
            </button>
            <button type="submit" class="pill primary">
              Check
            </button>
          </span>
        ) : null}
      </form>
      {checked !== null ? (
        <section class={`learn-answer ${checked ? "right" : "wrong"}`} aria-label="Answer">
          <p class="learn-verdict">{checked ? "Right" : "It prints:"}</p>
          {checked ? null : <pre class="coding-io">{example.output}</pre>}
          <button type="button" class="pill primary wide" onClick={onNext}>
            Next: plan
          </button>
        </section>
      ) : null}
    </main>
  );
}

/** Planning in words, typed or dictated, or recalling the plan for a problem solved before. */
function PlanStep({
  opened,
  session,
  change,
  online,
  openTutor,
  notify,
  boot,
  onNext,
  onSolve,
}: StepProps & { boot: Bootstrap; onNext: () => void; onSolve: (() => void) | null }) {
  const recall = session.mode === "recall";
  const setPlan = (plan: string) => change((s) => ({ ...s, plan }));
  return (
    <main class="learn-content">
      <Statement opened={opened} open />
      <form
        class="learn-form"
        onSubmit={(event) => {
          event.preventDefault();
          onNext();
        }}
      >
        <label class="learn-question" for="coding-plan">
          {recall
            ? "From memory: how would you solve it?"
            : "How will you solve it? A few lines is plenty."}
        </label>
        <textarea
          id="coding-plan"
          class="coding-plan"
          rows={6}
          value={session.plan}
          placeholder="Such as: what to keep track of, in what order, and what it costs"
          onInput={(event) => setPlan(event.currentTarget.value)}
        />
        <DictateButton
          serverDictation={boot.server_dictation}
          onHeard={(text) => {
            const plan = sessionPlan(session.plan, text);
            change((s) => ({ ...s, plan }), true);
          }}
          onNotice={notify}
        />
        <span class="learn-actions">
          <TutorButton online={online} openTutor={openTutor} />
          <button type="submit" class="pill primary">
            {recall ? "Compare with the approach" : "Next: code"}
          </button>
        </span>
      </form>
      {onSolve ? (
        <button type="button" class="learn-link" onClick={onSolve}>
          Solve it again instead
        </button>
      ) : null}
    </main>
  );
}

/** The plan with dictated words added on a line of their own. */
function sessionPlan(plan: string, heard: string): string {
  return plan.trim() ? `${plan.replace(/\s*$/, "")}\n${heard}` : heard;
}

/** Coding, in the editor, and running the examples; then submitting it to every test. */
function CodeStep({
  opened,
  session,
  change,
  online,
  openTutor,
  boot,
  itemKey,
  editor,
  draftSaver,
  onRan,
  onReloaded,
  onGiveUp,
}: StepProps & {
  boot: Bootstrap;
  itemKey: string;
  editor: { current: CodeEditor | null };
  draftSaver: { current: VersionedSaver | null };
  onRan: (summary: string) => void;
  onReloaded: (opened: Opened) => void;
  onGiveUp: () => void;
}) {
  const settings = useEditorSettings(boot.editor, editor);
  const [keyboard, setKeyboard] = useState(false);
  const statusHost = useRef<HTMLElement | null>(null);
  const placeStatus = useCallback((host: HTMLElement | null) => {
    statusHost.current = host;
    editor.current?.setStatusHost(host);
  }, []);
  const [busy, setBusy] = useState<"running" | "submitting" | null>(null);
  const [ran, setRan] = useState<Graded | null>(null);
  const [submitted, setSubmitted] = useState<Submitted | null>(null);
  const [runError, setRunError] = useState<string | null>(null);
  const [hintsShown, setHintsShown] = useState(0);
  const language = opened.languages.find((l) => l.id === session.language) ?? opened.languages[0];
  const testing = session.step === "test";

  const showKeyboard = (shown: boolean) => {
    setKeyboard(shown);
    editor.current?.setKeyboard(shown);
  };
  const keyboardShown = settings.ownKeyboard && keyboard && !testing;
  useEffect(() => {
    if (keyboardShown) editor.current?.revealCursor();
  }, [keyboardShown]);

  const runExamples = async () => {
    setBusy("running");
    setRunError(null);
    try {
      await draftSaver.current?.flush();
      const graded = await codingApi.run(itemKey);
      setRan(graded);
      onRan(summarise(graded));
      change((s) => ({ ...s, runs: s.runs + 1 }), true);
    } catch (e) {
      setRunError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    showKeyboard(false);
    setBusy("submitting");
    setRunError(null);
    setSubmitted(null);
    try {
      // Saved first, so the server tests what's in the editor, at the step it's at.
      await Promise.all([
        change((s) => ({ ...s, step: "test" }), true),
        draftSaver.current?.flush(),
      ]);
      const result = await codingApi.submit(itemKey);
      setSubmitted(result);
      onRan(result.problem ?? "Passed every test.");
      // The server moves a passing solution on to being reviewed.
      onReloaded(result.opened);
    } catch (e) {
      setRunError(errorMessage(e));
    } finally {
      setBusy(null);
    }
  };

  if (!language) return null;
  const hints = opened.hints.slice(0, hintsShown);
  return (
    <main class="coding-work">
      {testing ? (
        <TestResults
          busy={busy === "submitting"}
          submitted={submitted}
          error={runError}
          online={online}
          onBack={() => change((s) => ({ ...s, step: "code" }), true)}
          onSubmit={() => void submit()}
          onGiveUp={onGiveUp}
        />
      ) : (
        <>
          <div class="coding-toolbar">
            {opened.languages.length > 1 ? (
              <label class="coding-language">
                <span class="visually-hidden">Language</span>
                <select
                  value={language.id}
                  onChange={(event) => {
                    const id = event.currentTarget.value as Session["language"];
                    change((s) => ({ ...s, language: id }), true);
                  }}
                >
                  {opened.languages.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
            <details class="coding-statement compact">
              <summary>Problem</summary>
              <Markdown text={opened.prompt} class="learn-prompt" />
              {opened.examples.map((example, index) => (
                <section key={example.input} aria-label={`Example ${index + 1}`}>
                  <h3 class="coding-subheading">Example {index + 1}</h3>
                  <pre class="coding-io">{example.input}</pre>
                  <pre class="coding-io muted">{example.output}</pre>
                </section>
              ))}
              {session.plan.trim() ? (
                <>
                  <h3 class="coding-subheading">Your plan</h3>
                  <p class="coding-plan-text">{session.plan}</p>
                </>
              ) : null}
            </details>
            {opened.hints.length > hintsShown ? (
              <button
                type="button"
                class="text-button"
                onClick={() => {
                  setHintsShown((n) => n + 1);
                  change((s) => ({ ...s, hints: s.hints + 1 }));
                }}
              >
                {hintsShown === 0 ? "A hint" : "Another hint"}
              </button>
            ) : null}
            <button type="button" class="text-button" onClick={openTutor} disabled={!online}>
              Tutor
            </button>
          </div>
          {hints.length > 0 ? (
            <ol class="coding-hints" aria-label="Hints">
              {hints.map((hint) => (
                <li key={hint}>{hint}</li>
              ))}
            </ol>
          ) : null}
          <EditorPane
            key={language.id}
            itemKey={itemKey}
            language={language}
            settings={settings}
            editor={editor}
            saver={draftSaver}
            statusHost={statusHost}
          />
          {ran || runError ? (
            <ExampleResults
              ran={ran}
              error={runError}
              onDismiss={() => {
                setRan(null);
                setRunError(null);
              }}
            />
          ) : null}
          {keyboardShown ? (
            <Keyboard
              onKey={(key) => editor.current?.pressKey(key)}
              onLower={() => showKeyboard(false)}
              offsets={settings.keyOffsets.offsets}
              onTouch={settings.keyOffsets.onTouch}
              statusHost={placeStatus}
            />
          ) : (
            <footer class="coding-actions">
              {settings.ownKeyboard ? (
                <button type="button" class="pill" onClick={() => showKeyboard(true)}>
                  Type
                </button>
              ) : null}
              <button
                type="button"
                class="pill"
                disabled={!online || busy !== null}
                onClick={() => void runExamples()}
              >
                {busy === "running"
                  ? "Running…"
                  : online
                    ? "Run examples"
                    : "Running needs the server"}
              </button>
              <button
                type="button"
                class="pill primary"
                disabled={!online || busy !== null}
                onClick={() => void submit()}
              >
                Submit
              </button>
            </footer>
          )}
        </>
      )}
    </main>
  );
}

/** What running on the examples did, in a line, for the tutor. */
function summarise(graded: Graded): string {
  switch (graded.outcome) {
    case "build_failed":
      return `It didn't build:\n${graded.errors}`;
    case "unavailable":
      return graded.reason;
    case "ran":
      return graded.results
        .map(
          (r) =>
            `${describeCase(r.case)}: ${r.passed ? "passed" : describeRun(r.run)}\ninput:\n${r.input}\nexpected:\n${r.expected}\ngot:\n${r.run.stdout}${r.run.stderr ? `\nstderr:\n${r.run.stderr}` : ""}`,
        )
        .join("\n\n");
  }
}

function ExampleResults({
  ran,
  error,
  onDismiss,
}: {
  ran: Graded | null;
  error: string | null;
  onDismiss: () => void;
}) {
  return (
    <section class="coding-results" aria-label="Examples run">
      <span class="coding-results-head">
        <h2 class="coding-subheading">
          {error
            ? "Couldn't run it"
            : ran?.outcome === "ran"
              ? `${ran.results.filter((r) => r.passed).length} of ${ran.results.length} examples right`
              : ran?.outcome === "build_failed"
                ? "It doesn't build"
                : "Can't run it here"}
        </h2>
        <button type="button" class="text-button" onClick={onDismiss}>
          Close
        </button>
      </span>
      {error ? <p class="error-text">{error}</p> : null}
      {ran?.outcome === "build_failed" ? (
        <pre class="coding-io error-text">{ran.errors}</pre>
      ) : null}
      {ran?.outcome === "unavailable" ? <p class="error-text">{ran.reason}</p> : null}
      {ran?.outcome === "ran"
        ? ran.results.map((result) => (
            <CaseView key={JSON.stringify(result.case)} result={result} />
          ))
        : null}
    </section>
  );
}

function CaseView({ result }: { result: CaseResult }) {
  return (
    <article class={`coding-case ${result.passed ? "right" : "wrong"}`}>
      <p class="coding-case-head">
        {describeCase(result.case)}: {result.passed ? "right" : describeRun(result.run)}
      </p>
      {result.passed ? null : (
        <>
          <h3 class="coding-subheading">Input</h3>
          <pre class="coding-io">{result.input}</pre>
          <h3 class="coding-subheading">Expected</h3>
          <pre class="coding-io">{result.expected}</pre>
          <h3 class="coding-subheading">Got</h3>
          <pre class="coding-io">{result.run.stdout || "(nothing)"}</pre>
          {result.run.stderr.trim() ? (
            <pre class="coding-io error-text">{result.run.stderr}</pre>
          ) : null}
        </>
      )}
    </article>
  );
}

/** Submitting: the hidden tests and the brute force's answers, and the first input it fails on. */
function TestResults({
  busy,
  submitted,
  error,
  online,
  onBack,
  onSubmit,
  onGiveUp,
}: {
  busy: boolean;
  submitted: Submitted | null;
  error: string | null;
  online: boolean;
  onBack: () => void;
  onSubmit: () => void;
  onGiveUp: () => void;
}) {
  return (
    <div class="learn-content">
      {busy ? (
        <p class="muted" role="status">
          Running the hidden tests, and comparing with a brute force on random inputs…
        </p>
      ) : null}
      {error ? <p class="error-text">{error}</p> : null}
      {submitted && !submitted.passed ? (
        <section class="coding-results" aria-label="Test results">
          <h2 class="coding-subheading">
            {submitted.total > 0
              ? `Passed ${submitted.ran} of ${submitted.total}, then went wrong`
              : "It didn't run"}
          </h2>
          {submitted.failure ? (
            <CaseView result={submitted.failure} />
          ) : (
            <pre class="coding-io error-text">{submitted.problem}</pre>
          )}
        </section>
      ) : null}
      {!busy && !submitted && !error ? (
        <p class="muted">Submit to run it on the hidden tests.</p>
      ) : null}
      <span class="learn-actions">
        <button type="button" class="pill" onClick={onBack} disabled={busy}>
          Back to the code
        </button>
        <button type="button" class="pill primary" onClick={onSubmit} disabled={busy || !online}>
          {submitted || error ? "Submit again" : "Submit"}
        </button>
      </span>
      <button type="button" class="learn-link" onClick={onGiveUp} disabled={busy}>
        Give up and see how it's solved
      </button>
    </div>
  );
}

const RATINGS: [Rating, string][] = [
  ["again", "Forgot"],
  ["hard", "Hard"],
  ["good", "Good"],
  ["easy", "Easy"],
];

/** Comparing with how it's meant to be solved, and saying how it went, which schedules it. */
function ReviewStep({
  opened,
  session,
  online,
  onFinish,
}: StepProps & { onFinish: (rating: Rating) => Promise<void> }) {
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const suggested = suggestedRating(session);
  const solution = opened.solution;
  const reference =
    solution?.reference.find((r) => r.language === session.language) ?? solution?.reference[0];
  const recall = session.mode === "recall";
  return (
    <main class="learn-content">
      {recall ? null : (
        <p class={`learn-verdict ${session.passed ? "right" : "wrong"}`}>
          {session.passed ? "Solved: it passed every test." : "Not solved this time."}
        </p>
      )}
      <section aria-label="Your plan">
        <h2 class="coding-subheading">Your plan</h2>
        <p class="coding-plan-text">{session.plan.trim() || "(none written)"}</p>
        {recall && opened.previous_plan?.trim() ? (
          <>
            <h2 class="coding-subheading">Your plan last time</h2>
            <p class="coding-plan-text">{opened.previous_plan}</p>
          </>
        ) : null}
      </section>
      {solution ? (
        <section aria-label="Approach">
          <h2 class="coding-subheading">How it's solved</h2>
          <Markdown text={solution.approach} />
          {reference ? (
            <details class="coding-statement">
              <summary>A solution</summary>
              <pre class="coding-io coding-reference">{reference.text}</pre>
            </details>
          ) : null}
          {solution.notes ? <Markdown text={solution.notes} class="muted" /> : null}
        </section>
      ) : (
        <p class="muted">
          {online
            ? "Loading how it's solved…"
            : "How it's solved comes from the server, once it can be reached."}
        </p>
      )}
      <p class="learn-question muted">{recall ? "Did your plan match?" : "How did it go?"}</p>
      <div class="learn-ratings">
        {RATINGS.map(([rating, label]) => (
          <button
            key={rating}
            type="button"
            class={`pill rating ${rating} ${rating === suggested ? "suggested" : ""}`}
            disabled={saving || !online}
            onClick={() => {
              setSaving(true);
              setProblem(null);
              onFinish(rating)
                .catch((e: unknown) => setProblem(errorMessage(e)))
                .finally(() => setSaving(false));
            }}
          >
            {label}
          </button>
        ))}
      </div>
      {suggested ? (
        <p class="muted coding-hint">
          Suggested: {RATINGS.find(([r]) => r === suggested)?.[1]}, from how it went.
        </p>
      ) : null}
      {online ? null : <p class="muted">Saying how it went needs the server.</p>}
      {problem ? <p class="error-text">{problem}</p> : null}
    </main>
  );
}

function Finished({
  due,
  mode,
  onHome,
  onList,
  onSolve,
}: {
  due: number | null;
  mode: Session["mode"];
  onHome: () => void;
  onList: () => void;
  onSolve: () => void;
}) {
  const days = due === null ? null : Math.max(0, Math.round((due - Date.now()) / 86_400_000));
  return (
    <main class="learn-content">
      <section class="learn-done" aria-label="Done">
        <h2>That's it done</h2>
        <p class="muted">
          {days === null
            ? "Saved."
            : days === 0
              ? "It comes back later today."
              : `It comes back in about ${days} ${days === 1 ? "day" : "days"}.`}
        </p>
        <span class="learn-actions">
          <button type="button" class="pill" onClick={onHome}>
            Home
          </button>
          <button type="button" class="pill primary" onClick={onList}>
            More coding
          </button>
        </span>
        {mode === "recall" ? (
          <button type="button" class="learn-link" onClick={onSolve}>
            Solve it again now
          </button>
        ) : null}
      </section>
    </main>
  );
}
