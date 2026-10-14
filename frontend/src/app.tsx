import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  type Bootstrap,
  ConnectionError,
  connection,
  type DayMeta,
  type Exchange,
  type Problem,
  type Puzzle,
  type Tab,
  type UiState,
} from "./api";
import { type LocalCommand, matchCommand } from "./commands";
import { resolveDictation } from "./dictation";
import {
  type Anchor,
  CodeEditor,
  type Diagnostics,
  hoverText,
  LanguageServerConnection,
  type LanguageServerStatus,
} from "./editor";
import { useConnection } from "./hooks/useConnection";
import { useDiscussion } from "./hooks/useDiscussion";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePackages } from "./hooks/usePackages";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { findMissingModule, isUpToDate } from "./packages";
import * as preferences from "./preferences";
import { isPractice, PRACTICE, puzzleLabel, puzzleTitle } from "./puzzle";
import { EMPTY_META, sampleInput, withSuggestions } from "./samples";
import { debounced, type FileVersion, LatestSaver, type SaveStatus, VersionedSaver } from "./saver";
import {
  type Job,
  type JobContext,
  type Outcome,
  type Card as UtteranceCard,
  UtteranceQueue,
} from "./utterances";
import { SpeechBench } from "./views/bench";
import { Controls } from "./views/controls";
import { DiscussView } from "./views/discuss";
import { ConflictBanner } from "./views/frame";
import { Help } from "./views/help";
import { Modal } from "./views/modal";
import { MissingPackageBanner, OutdatedPackagesBanner } from "./views/packages";
import { Picker } from "./views/picker";
import { ProblemView } from "./views/problem";
import {
  describeEnding,
  type InputKind,
  initialRunState,
  RunSheet,
  type RunState,
} from "./views/run";
import { Settings } from "./views/settings";
import { Setup } from "./views/setup";
import { Stack } from "./views/stack";
import { speechUnavailableReason } from "./voice";
import { ScreenWakeLock, wakeLockSupported } from "./wakelock";

type Sheet = "run" | "settings" | "help" | "setup" | "bench" | null;

const TABS = ["problem", "code", "notes", "discuss"] as const;

/** How long an utterance waits for a puzzle's editor that's still loading. */
const EDITOR_WAIT_MS = 10_000;

/** The space kept clear below the code for the cards floating over it. */
const insetFor = (stackHeight: number) => (stackHeight > 0 ? stackHeight + 16 : 0);

/** What an utterance needs besides its words. */
interface UtteranceDetail {
  /** The speech recogniser's own pieces, when it revised what it heard. */
  pieces: string[];
  /** The edit model's earlier questions, when this answers one. */
  earlier: Exchange[] | null;
  /** Where the cursor was when it was spoken. */
  anchor: { editor: CodeEditor; anchor: Anchor } | null;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App({ boot }: { boot: Bootstrap }) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(boot.state.puzzle);
  const [tab, setTab] = useState<Tab>(boot.state.tab);
  // On a wide screen the puzzle has a column of its own, beside the other tabs.
  const wide = useMediaQuery("(min-width: 1000px)");
  const online = useConnection();
  const shownTab: Tab = wide && tab === "problem" ? "code" : tab;
  const [models, setModels] = useState(boot.models);
  const [chosenDiscussModel, setDiscussModel] = useState(boot.state.discuss_model);
  // The chosen discussion model, if the current provider offers it, or its first model.
  const discussModel =
    chosenDiscussModel && models.discuss_models.includes(chosenDiscussModel)
      ? chosenDiscussModel
      : (models.discuss_models[0] ?? "");
  const [sheet, setSheet] = useState<Sheet>(boot.needs_setup ? "setup" : null);
  const [hasSession, setHasSession] = useState(boot.has_aoc_session);
  const [picking, setPicking] = useState(false);

  const [openError, setOpenError] = useState<string | null>(null);
  const [meta, setMeta] = useState<DayMeta>(EMPTY_META);
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [problemLoading, setProblemLoading] = useState(false);

  const [cards, setCards] = useState<UtteranceCard[]>([]);
  const [stackHeight, setStackHeight] = useState(0);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({ errors: 0, warnings: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [codeConflict, setCodeConflict] = useState<FileVersion | null>(null);
  const [notesConflict, setNotesConflict] = useState<FileVersion | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [run, setRun] = useState<RunState>(initialRunState);
  const packages = usePackages(boot.language.packages !== null);
  const discussion = useDiscussion(puzzle, discussModel, () => {
    const last = latest.current.run.last;
    return {
      code: editor.current?.text() ?? "",
      errors: editor.current?.diagnosticsText() ?? "",
      lastRun: last
        ? `${last.input} input: ${describeEnding(last.result)}\nstdout:\n${last.result.stdout}\nstderr:\n${last.result.stderr}`
        : "",
    };
  });
  // The edit model's latest question: its card, and the requests that led to it. Replying to it
  // sends the next utterance as the answer, rather than starting afresh.
  const [question, setQuestion] = useState<{ card: number; exchanges: Exchange[] } | null>(null);
  const [replying, setReplying] = useState(false);

  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditor | null>(null);
  // Utterances spoken while a puzzle's editor is still loading wait for it.
  const editorWaiters = useRef<((editor: CodeEditor) => void)[]>([]);
  const stackHeightRef = useRef(0);
  const saver = useRef<VersionedSaver | null>(null);
  const notesSaver = useRef<VersionedSaver | null>(null);
  const [lspStatus, setLspStatus] = useState<LanguageServerStatus>("connecting");
  const lsp = useMemo(
    () =>
      boot.language.has_lsp
        ? new LanguageServerConnection(boot.language.root_uri, setLspStatus)
        : null,
    [boot],
  );
  useEffect(() => () => lsp?.close(), [lsp]);
  useEffect(() => {
    if (lspStatus === "reconnecting") editor.current?.clearDiagnostics();
  }, [lspStatus]);
  const fileUri = useRef<string | null>(null);
  const metaRef = useRef(meta);
  const puzzleRef = useRef(puzzle);
  // Utterances are handled one at a time, in the order they were spoken. The handler is set
  // each render, so it sees the latest state.
  const handleUtterance = useRef<
    (job: Job<UtteranceDetail>, context: JobContext) => Promise<Outcome>
  >(async () => ({ kind: "cancelled" }));
  const queue = useMemo(
    () =>
      new UtteranceQueue<UtteranceDetail>(
        (job, context) => handleUtterance.current(job, context),
        setCards,
        ({ detail: { anchor } }) => anchor?.editor.release(anchor.anchor),
      ),
    [],
  );
  const notify = (tone: "ok" | "info" | "warn" | "error", text: string) => queue.notify(tone, text);
  const [keepScreenOn, setKeepScreenOn] = useState(() => preferences.keepScreenOn.get());
  const [lineWrapping, setLineWrapping] = useState(() => preferences.lineWrapping.get());
  const [dictationChoice, setDictationChoice] = useState(() => preferences.dictation.get());
  const wakeLock = useMemo(() => new ScreenWakeLock(), []);
  useEffect(() => () => wakeLock.dispose(), [wakeLock]);
  useEffect(() => wakeLock.setEnabled(keepScreenOn), [wakeLock, keepScreenOn]);
  // Queued utterances run after later renders, so they read the latest state through refs.
  const latest = useRef({ tab: shownTab, notes, run, question, replying });
  latest.current = { tab: shownTab, notes, run, question, replying };
  puzzleRef.current = puzzle;

  // One saver per puzzle, so switching puzzles never drops the previous one's unsaved changes.
  const metaSavers = useRef(new Map<string, LatestSaver<DayMeta>>());
  const saveMetaSoon = useCallback(({ p, m }: { p: Puzzle; m: DayMeta }) => {
    const key = `${p.year}-${p.day}`;
    let saver = metaSavers.current.get(key);
    if (!saver) {
      saver = new LatestSaver<DayMeta>(
        (meta, keepalive) => api.saveMeta(p, meta, keepalive),
        600,
        (e) => notify("error", `Couldn't save, retrying: ${e}`),
      );
      metaSavers.current.set(key, saver);
    }
    saver.schedule(m);
  }, []);
  const updateMeta = useCallback(
    (next: DayMeta) => {
      metaRef.current = next;
      setMeta(next);
      if (puzzleRef.current) saveMetaSoon({ p: puzzleRef.current, m: next });
    },
    [saveMetaSoon],
  );

  const updateNotes = (text: string) => {
    latest.current.notes = text;
    setNotes(text);
    notesSaver.current?.schedule(text);
  };

  // Remember where the user is, so a reload reopens the same view.
  const stateSaver = useMemo(
    () =>
      new LatestSaver<UiState>(
        (state, keepalive) => api.saveState(state, keepalive),
        500,
        () => {},
      ),
    [],
  );
  useEffect(() => {
    stateSaver.schedule({ puzzle, tab, discuss_model: discussModel });
  }, [puzzle, tab, discussModel, stateSaver]);

  const lookUpType = useMemo(
    () =>
      debounced((pos: number) => {
        const client = lsp?.client;
        const view = editor.current?.view;
        if (!client || !view || !fileUri.current) return;
        hoverText(client, fileUri.current, view, pos)
          .then(setHover)
          .catch(() => setHover(null));
      }, 500),
    [],
  );

  const loadProblem = useCallback(
    async (p: Puzzle, refresh: boolean) => {
      setProblemLoading(true);
      setProblemError(null);
      try {
        const loaded = await api.problem(p, refresh);
        if (puzzleRef.current !== p) return;
        setProblem(loaded);
        const suggested = withSuggestions(metaRef.current, loaded);
        if (suggested !== metaRef.current) updateMeta(suggested);
      } catch (e) {
        if (puzzleRef.current === p) setProblemError(message(e));
      } finally {
        if (puzzleRef.current === p) setProblemLoading(false);
      }
    },
    [updateMeta],
  );

  // Open the selected puzzle: load its code, notes and state, and create the editor.
  useEffect(() => {
    if (!puzzle) return;
    let cancelled = false;
    setProblem(null);
    setOpenError(null);
    setRun(initialRunState);
    setCodeConflict(null);
    setNotesConflict(null);
    setSaveStatus("saved");
    setDiagnostics({ errors: 0, warnings: 0 });
    setHover(null);

    (async () => {
      try {
        const opened = await api.open(puzzle);
        if (cancelled) return;
        metaRef.current = opened.meta;
        setMeta(opened.meta);
        void loadProblem(puzzle, false);

        const host = editorHost.current;
        if (!host) return;
        fileUri.current = opened.file_uri;
        const key = `${puzzle.year}-${puzzle.day}`;
        const codeSaver = new VersionedSaver(
          (text, version, keepalive) => api.saveCode(puzzle, text, version, keepalive),
          `workshop:unsaved:code:${key}`,
          opened.code.version,
          opened.code.text,
          setSaveStatus,
          setCodeConflict,
        );
        saver.current = codeSaver;
        const notes = new VersionedSaver(
          (text, version, keepalive) => api.saveNotes(puzzle, text, version, keepalive),
          `workshop:unsaved:notes:${key}`,
          opened.notes.version,
          opened.notes.text,
          (status, detail) => {
            if (status === "error") {
              notify("error", `Couldn't save notes, retrying: ${detail}`);
            }
          },
          setNotesConflict,
        );
        notesSaver.current = notes;
        const notesText = notes.recover();
        latest.current.notes = notesText;
        setNotes(notesText);
        const created = new CodeEditor(host, {
          doc: codeSaver.recover(),
          cursor: opened.meta.cursor,
          mode: boot.language.editor_mode,
          lineWrapping: preferences.lineWrapping.get(),
          lsp: lsp
            ? {
                client: lsp.client,
                uri: opened.file_uri,
                languageId: boot.language.lsp_language_id,
              }
            : null,
          onChange: (text) => codeSaver.schedule(text),
          onCursor: (pos) => {
            if (metaRef.current.cursor !== pos) updateMeta({ ...metaRef.current, cursor: pos });
            lookUpType(pos);
          },
          onDiagnostics: (d) =>
            setDiagnostics((prev) =>
              prev.errors === d.errors && prev.warnings === d.warnings ? prev : d,
            ),
        });
        created.setBottomInset(insetFor(stackHeightRef.current));
        editor.current = created;
        for (const waiter of editorWaiters.current.splice(0)) waiter(created);
      } catch (e) {
        if (!cancelled) setOpenError(message(e));
      }
    })();

    return () => {
      cancelled = true;
      saver.current?.close();
      saver.current = null;
      notesSaver.current?.close();
      notesSaver.current = null;
      editor.current?.destroy();
      editor.current = null;
    };
  }, [puzzle, boot, lsp, loadProblem, updateMeta, lookUpType]);

  // Save when the phone is put down, and pick up changes made at a desk when it comes back.
  useEffect(() => {
    const onHide = () => {
      saver.current?.flushOnExit();
      notesSaver.current?.flushOnExit();
      for (const metaSaver of metaSavers.current.values()) metaSaver.flushOnExit();
      stateSaver.flushOnExit();
    };
    const onVisibility = async () => {
      if (document.visibilityState === "hidden") {
        onHide();
        return;
      }
      const p = puzzleRef.current;
      const current = editor.current;
      if (!p || !current) return;
      try {
        const opened = await api.open(p);
        if (puzzleRef.current !== p || editor.current !== current) return;
        // Each saver only takes the version from elsewhere if there are no local changes;
        // otherwise it saves them, which reports a conflict if the file changed.
        if (saver.current?.adopt(opened.code)) {
          current.replaceAll(opened.code.text);
          notify("info", "Loaded code changed elsewhere.");
        }
        if (notesSaver.current?.adopt(opened.notes)) {
          latest.current.notes = opened.notes.text;
          setNotes(opened.notes.text);
        }
      } catch {
        // Offline or the server restarted; the next save will report any real problem.
      }
    };
    window.addEventListener("pagehide", onHide);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [stateSaver]);

  const part = problem ? (problem.stars >= 2 ? null : problem.stars + 1) : 1;
  const expected = part === null ? null : (meta.sample_answers[part - 1] ?? null);

  /**
   * Runs the solution. From the Run sheet it first waits for edits still being made from
   * earlier utterances, so it runs what was said; a spoken "run" is already queued after them.
   */
  const doRun = async (input: InputKind, waitForEdits: boolean) => {
    const p = puzzleRef.current;
    if (!p) return;
    setSheet("run");
    const runPart = part ?? 2;
    if (input === "sample" && sampleInput(metaRef.current, runPart === 1 ? 0 : 1) === null) {
      setRun((r) => ({
        ...r,
        error: "Choose the sample input first: tap a code block in the puzzle.",
      }));
      return;
    }
    setRun((r) => ({ ...r, running: input, error: null, submitted: null, confirmSubmit: false }));
    try {
      if (waitForEdits) await queue.idle();
      try {
        // The run reads the code and the chosen sample from the server.
        await saver.current?.flush();
        await metaSavers.current.get(`${p.year}-${p.day}`)?.flush();
      } catch (e) {
        setRun((r) => ({ ...r, running: null, error: `Not run: ${message(e)}` }));
        return;
      }
      const result = await api.run(p, input, runPart);
      setRun((r) => ({ ...r, running: null, last: { input, result } }));
    } catch (e) {
      setRun((r) => ({ ...r, running: null, error: message(e) }));
    }
  };

  const doSubmit = async (answer: string) => {
    const p = puzzleRef.current;
    if (!p || part === null) return;
    setRun((r) => ({ ...r, submitting: true }));
    try {
      const { outcome, problem: refreshed } = await api.submit(p, part, answer);
      setRun((r) => ({ ...r, submitting: false, submitted: outcome, confirmSubmit: false }));
      if (refreshed) {
        setProblem(refreshed);
        updateMeta(withSuggestions(metaRef.current, refreshed));
      }
    } catch (e) {
      setRun((r) => ({ ...r, submitting: false, confirmSubmit: false, error: message(e) }));
    }
  };

  // A module the language server or the last run says is missing.
  const missing = useMemo(() => {
    const hints = boot.language.packages;
    if (hints === null) return null;
    const errors = [editor.current?.diagnosticsText() ?? "", run.last?.result.stderr ?? ""];
    return findMissingModule(errors.join("\n"), hints);
  }, [diagnostics, run.last, boot.language.packages]);
  const [outdatedDismissed, setOutdatedDismissed] = useState(false);
  const outdated =
    packages.state !== null &&
    packages.state.problem === null &&
    packages.state.packages.length > 0 &&
    !isUpToDate(packages.state);

  const openPuzzle = (p: Puzzle) => {
    setPicking(false);
    if (!puzzle || p.year !== puzzle.year || p.day !== puzzle.day) {
      setPuzzle(p);
      setTab("problem");
    }
  };

  const packageFor = async (module: string): Promise<string | null> => {
    try {
      const found = await packages.resolve(module);
      return "package" in found ? found.package : null;
    } catch {
      return null;
    }
  };

  const installPackage = async (pkg: string) => {
    if (await packages.add(pkg)) {
      notify("ok", `Installed ${pkg}`);
    } else {
      notify("error", `Couldn't install ${pkg}; see Settings, Packages.`);
    }
  };

  const done = (text: string): Outcome => ({ kind: "done", tone: "ok", text });
  const warn = (text: string): Outcome => ({ kind: "problem", tone: "warn", text });

  const runCommand = (command: LocalCommand): Outcome => {
    const current = editor.current;
    switch (command.kind) {
      case "undo":
        current?.undo();
        return done("Undone");
      case "redo":
        current?.redo();
        return done("Redone");
      case "run":
        void doRun(command.input, false);
        return done(command.input === "sample" ? "Running the sample" : "Running the real input");
      case "submit":
        setSheet("run");
        if (latest.current.run.last?.input === "real") {
          setRun((r) => ({ ...r, confirmSubmit: true }));
          return done("Confirm to submit");
        }
        return warn("Run on the real input first.");
      case "gotoLine":
        setTab("code");
        return current?.gotoLine(command.line)
          ? done(`Line ${command.line}`)
          : warn(`There's no line ${command.line}.`);
      case "nextError":
        setTab("code");
        current?.nextError();
        return done("Next error");
      case "previousError":
        setTab("code");
        current?.previousError();
        return done("Previous error");
      case "snippet": {
        const snippet = boot.snippets.find((s) => s.name === command.name);
        if (!snippet || !current) return warn(`There's no snippet called ${command.name}.`);
        current.insertSnippet(snippet.body);
        return done(`Inserted ${snippet.name}`);
      }
      case "tab":
        setTab(command.tab);
        return done(`Showing ${command.tab}`);
      case "install": {
        if (boot.language.packages === null) {
          return warn(`${boot.language.name} has no packages to install.`);
        }
        // Installing can take a while, so it carries on in the background, shown in a banner.
        if (command.package !== null) {
          void installPackage(command.package);
          return { kind: "done", tone: "info", text: `Installing ${command.package}` };
        }
        if (missing === null) return warn("Say which package, like “install package split”.");
        void (async () => {
          const found = missing.package ?? (await packageFor(missing.module));
          if (found === null) {
            notify(
              "warn",
              `Couldn't find a package for ${missing.module}; add it in Settings, under Packages.`,
            );
          } else {
            await installPackage(found);
          }
        })();
        return { kind: "done", tone: "info", text: `Installing the package for ${missing.module}` };
      }
    }
  };

  /** The editor, waiting for it if a puzzle is open but its editor is still loading. */
  const editorReady = (): Promise<CodeEditor | null> => {
    if (editor.current) return Promise.resolve(editor.current);
    if (puzzleRef.current === null) return Promise.resolve(null);
    return new Promise((resolve) => {
      const waiter = (ready: CodeEditor) => {
        clearTimeout(timer);
        resolve(ready);
      };
      const timer = setTimeout(() => {
        editorWaiters.current = editorWaiters.current.filter((w) => w !== waiter);
        resolve(null);
      }, EDITOR_WAIT_MS);
      editorWaiters.current.push(waiter);
    });
  };

  /**
   * Makes a request, and if the server can't be reached, waits until it can and tries again,
   * so what was said while it was away isn't lost.
   */
  const untilReached = async <T,>(
    context: JobContext,
    label: string,
    request: () => Promise<T>,
  ): Promise<T> => {
    for (;;) {
      context.working(label);
      try {
        return await request();
      } catch (e) {
        if (!(e instanceof ConnectionError)) throw e;
        context.working("Waiting for the server");
        await connection.whenOnline(context.signal);
      }
    }
  };

  const doEdit = async (
    job: Job<UtteranceDetail>,
    earlier: Exchange[],
    context: JobContext,
  ): Promise<Outcome> => {
    const current = await editorReady();
    if (!current) return warn("Open a puzzle first.");
    const { anchor, pieces } = job.detail;
    if (anchor?.editor === current) current.restore(anchor.anchor);
    const marked = current.markedText();
    const before = current.text();
    try {
      const result = await untilReached(context, "Editing", () =>
        api.edit(marked, job.text, pieces, current.recentInsertion, earlier, context.signal),
      );
      if (context.signal.aborted) return { kind: "cancelled" };
      if (editor.current !== current || current.text() !== before) {
        return warn("The code changed while I was thinking, so I left it alone.");
      }
      const seconds = `${(result.elapsed_ms / 1000).toFixed(1)}s`;
      if (result.status === "applied") {
        current.applyMarked(result.doc, result.inserted);
        const model = result.model ? ` · ${result.model.replace(/^claude-/, "")}` : "";
        return done(`${result.summary} · ${seconds}${model}`);
      }
      setQuestion({
        card: job.id,
        exchanges: [...earlier, { said: job.text, asked: result.message }],
      });
      return { kind: "asked", question: result.message };
    } catch (e) {
      if (context.signal.aborted) return { kind: "cancelled" };
      api.log("error", `edit ${JSON.stringify(job.text)}: ${message(e)}`);
      return { kind: "problem", tone: "error", text: message(e) };
    }
  };

  handleUtterance.current = async (job, context) => {
    const { earlier, anchor } = job.detail;
    if (earlier) {
      // A reply to the edit model's question, wherever it was spoken from.
      api.log("speech", `reply: ${job.text}`);
      return doEdit(job, earlier, context);
    }
    const { tab, notes } = latest.current;
    const command =
      tab === "code" || tab === "problem"
        ? matchCommand(
            job.text,
            boot.snippets.map((s) => s.name),
          )
        : null;
    if (tab === "notes" || tab === "discuss" || command) {
      // Not an edit, so where the cursor was doesn't matter.
      if (anchor) anchor.editor.release(anchor.anchor);
    }
    if (tab === "notes") {
      api.log("speech", `notes: ${job.text}`);
      updateNotes(notes ? `${notes.replace(/\s*$/, "")}\n${job.text}` : job.text);
      return { kind: "done", tone: "info", text: "Added to notes" };
    }
    if (tab === "discuss") {
      api.log("speech", `discuss: ${job.text}`);
      context.working("Asking the coach");
      await discussion.send(job.text);
      return { kind: "done", tone: "info", text: "Answered in Discuss" };
    }
    if (command) {
      api.log("command", `${JSON.stringify(job.text)} -> ${JSON.stringify(command)}`);
      return runCommand(command);
    }
    return doEdit(job, [], context);
  };

  /** Queues what was said or typed. `card` is the card already shown while it was said. */
  const enqueue = (text: string, pieces: string[] = [], card?: number) => {
    const { replying, question } = latest.current;
    // Whether answering the question or starting afresh, the question's card has had its turn.
    if (question) queue.dismiss(question.card);
    setQuestion(null);
    setReplying(false);
    const current = editor.current;
    const detail: UtteranceDetail = {
      pieces,
      earlier: replying && question ? question.exchanges : null,
      anchor: current ? { editor: current, anchor: current.anchor() } : null,
    };
    queue.enqueue(text, detail, card);
  };

  const talk = usePushToTalk({
    vocabulary: () => editor.current?.identifiers() ?? [],
    onStart: () => queue.reserveId(),
    onUtterance: (id, text, pieces) => enqueue(text, pieces, id),
    onNotice: notify,
  });
  const { hasSpeech, listening } = talk;
  const dictationMethod = resolveDictation(dictationChoice, hasSpeech);
  // Keeps the code clear of the cards floating over its bottom edge.
  useEffect(() => {
    stackHeightRef.current = stackHeight;
    editor.current?.setBottomInset(insetFor(stackHeight));
  }, [stackHeight]);
  useEffect(() => {
    if (!hasSpeech) notify("warn", speechUnavailableReason());
  }, []);
  // Typing commands is handy at a desk, and the only option without speech recognition.
  const showTyped = useMemo(
    () => !hasSpeech || window.matchMedia("(pointer: fine)").matches,
    [hasSpeech],
  );

  const toggleKeyboard = () => {
    const next = !keyboard;
    setKeyboard(next);
    setTab("code");
    editor.current?.setKeyboard(next);
  };

  const resolveCodeConflict = (keep: "mine" | "theirs") => {
    if (!codeConflict) return;
    if (keep === "mine") {
      saver.current?.keepMine(codeConflict);
    } else {
      saver.current?.takeTheirs(codeConflict);
      editor.current?.replaceAll(codeConflict.text);
    }
    setCodeConflict(null);
  };

  const resolveNotesConflict = (keep: "mine" | "theirs") => {
    if (!notesConflict) return;
    if (keep === "mine") {
      notesSaver.current?.keepMine(notesConflict);
    } else {
      notesSaver.current?.takeTheirs(notesConflict);
      latest.current.notes = notesConflict.text;
      setNotes(notesConflict.text);
    }
    setNotesConflict(null);
  };

  const stars = problem ? "★".repeat(problem.stars) : "";
  const statusParts: string[] = [];
  if (lsp && lspStatus !== "ready") {
    statusParts.push("starting checks");
  } else if (lsp) {
    statusParts.push(
      diagnostics.errors || diagnostics.warnings
        ? `${diagnostics.errors} error${diagnostics.errors === 1 ? "" : "s"}${diagnostics.warnings ? `, ${diagnostics.warnings} warning${diagnostics.warnings === 1 ? "" : "s"}` : ""}`
        : "no errors",
    );
  }
  if (saveStatus === "error") statusParts.push("not saved");
  else if (saveStatus !== "saved" && saveStatus !== "conflict") statusParts.push("saving");

  // The picker is the home screen until a puzzle is open, and can be reopened from the header.
  const showPicker = picking || puzzle === null;

  const problemView = puzzle ? (
    <ProblemView
      puzzle={puzzle}
      problem={problem}
      error={problemError}
      loading={problemLoading}
      meta={meta}
      onMeta={updateMeta}
      onRefresh={() => puzzle && void loadProblem(puzzle, true)}
      onStartAgain={
        puzzle && isPractice(puzzle)
          ? () => {
              api
                .resetPractice()
                .then(setProblem)
                .catch((e: unknown) => setProblemError(message(e)));
            }
          : null
      }
    />
  ) : null;
  const split = wide && !showPicker && problemView !== null;

  return (
    <div class={`app ${split ? "split" : ""}`}>
      <header class="top">
        {showPicker ? (
          puzzle ? (
            <button type="button" class="puzzle-button" onClick={() => setPicking(false)}>
              ‹ Back to {puzzleLabel(puzzle)}
            </button>
          ) : (
            <h1 class="app-title">Workshop</h1>
          )
        ) : (
          <button
            type="button"
            class="puzzle-button"
            onClick={() => {
              setSheet(null);
              setPicking(true);
            }}
          >
            {puzzle ? puzzleLabel(puzzle) : ""}
            {stars ? <span class="stars"> {stars}</span> : null}
          </button>
        )}
        <span class="header-actions">
          <button
            type="button"
            class="icon-button"
            aria-label="Help"
            onClick={() => setSheet(sheet === "help" ? null : "help")}
          >
            ?
          </button>
          <button
            type="button"
            class="icon-button"
            aria-label="Settings"
            onClick={() => setSheet(sheet === "settings" ? null : "settings")}
          >
            ⚙
          </button>
        </span>
      </header>
      {split ? <aside class="side">{problemView}</aside> : null}

      <nav class={`tabs ${showPicker ? "hidden" : ""}`}>
        {(wide ? (["code", "notes", "discuss"] as const) : TABS).map((t) => (
          <button
            type="button"
            key={t}
            class={t === shownTab ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t === "discuss" ? "Discuss" : t[0]?.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main class="content" style={{ "--stack-height": `${stackHeight}px` }}>
        <Stack
          cards={cards}
          live={talk.live}
          replyingTo={replying ? (question?.card ?? null) : null}
          onDismiss={(id) => {
            if (question?.card === id) {
              setQuestion(null);
              setReplying(false);
            }
            queue.dismiss(id);
          }}
          onReply={() => setReplying(true)}
          onCancelReply={() => setReplying(false)}
          onHeight={setStackHeight}
        />
        {showPicker ? (
          <div class="pane">
            <Picker current={puzzle} hasSession={hasSession} onPick={openPuzzle} />
          </div>
        ) : null}
        {online ? null : (
          <div class="banner offline" role="status">
            Can't reach the server. Is it running, and is this device connected to it? Trying again…
          </div>
        )}
        {openError && !showPicker ? <p class="pane error-text">{openError}</p> : null}
        {codeConflict && !showPicker ? (
          <ConflictBanner what="code" onResolve={resolveCodeConflict} />
        ) : null}
        {notesConflict && !showPicker ? (
          <ConflictBanner what="notes" onResolve={resolveNotesConflict} />
        ) : null}
        {missing && !showPicker ? (
          <MissingPackageBanner
            missing={missing}
            packages={packages}
            onInstall={(pkg) => void installPackage(pkg)}
            onOpenSettings={() => setSheet("settings")}
          />
        ) : outdated && !outdatedDismissed && !showPicker ? (
          <OutdatedPackagesBanner
            packages={packages}
            onDismiss={() => setOutdatedDismissed(true)}
          />
        ) : null}
        <div class={`code-pane ${shownTab === "code" && !showPicker ? "" : "hidden"}`}>
          <div class="status-line">
            <span>{statusParts.join(" · ")}</span>
            {hover ? <code class="hover">{hover}</code> : null}
          </div>
          <div class="editor" ref={editorHost} />
        </div>
        {!showPicker && !wide && shownTab === "problem" ? problemView : null}
        {!showPicker && shownTab === "notes" ? (
          <div class="pane notes">
            <textarea
              value={notes}
              onInput={(e) => updateNotes((e.target as HTMLTextAreaElement).value)}
              placeholder="Rough thoughts. Hold the button to dictate."
            />
          </div>
        ) : null}
        {!showPicker && shownTab === "discuss" ? (
          <DiscussView
            turns={discussion.turns}
            models={models.discuss_models}
            model={discussModel}
            thinking={discussion.thinking}
            partial={discussion.partial}
            error={discussion.error}
            onModel={setDiscussModel}
            onSend={(text) => enqueue(text)}
            onClear={discussion.clear}
          />
        ) : null}
        {sheet === "setup" ? (
          <Modal title="Set up Workshop" onClose={() => setSheet(null)} shape="full">
            <Setup
              models={models}
              onModels={setModels}
              packages={packages}
              onPractice={() => {
                setSheet(null);
                openPuzzle(PRACTICE);
              }}
              onLoggedIn={() => setHasSession(true)}
              onDone={() => setSheet(null)}
            />
          </Modal>
        ) : null}
        {sheet === "bench" ? (
          <Modal title="Compare speech recognition" onClose={() => setSheet(null)} shape="full">
            <SpeechBench />
          </Modal>
        ) : null}
        {sheet === "help" ? (
          <Modal title="How Workshop works" onClose={() => setSheet(null)} shape="full">
            <Help />
          </Modal>
        ) : null}
        {sheet === "run" ? (
          <Modal title="Run" onClose={() => setSheet(null)} shape="sheet">
            <RunSheet
              state={run}
              part={part}
              expected={expected}
              onRun={(input) => void doRun(input, true)}
              onCancel={() => void api.cancelRun()}
              onAskSubmit={() => setRun((r) => ({ ...r, confirmSubmit: true }))}
              onSubmit={(answer) => void doSubmit(answer)}
              onDismissSubmit={() => setRun((r) => ({ ...r, confirmSubmit: false }))}
              finalStar={problem?.final_star ?? null}
              hasSample={sampleInput(meta, part === 1 ? 0 : 1) !== null}
              onClaimFinalStar={() => void doSubmit("0")}
            />
          </Modal>
        ) : null}
        {sheet === "settings" ? (
          <Modal title="Settings" onClose={() => setSheet(null)} shape="full">
            <Settings
              snippets={boot.snippets}
              models={models}
              onModels={setModels}
              onSetup={() => setSheet("setup")}
              onBench={() => setSheet("bench")}
              commitMessage={puzzle ? puzzleTitle(puzzle) : "Advent of Code"}
              keepScreenOn={wakeLockSupported() ? keepScreenOn : null}
              onKeepScreenOn={(enabled) => {
                preferences.keepScreenOn.set(enabled);
                setKeepScreenOn(enabled);
              }}
              packages={packages}
              dictation={{
                choice: dictationChoice,
                method: dictationMethod,
                browserSpeech: hasSpeech,
              }}
              onDictation={(choice) => {
                preferences.dictation.set(choice);
                setDictationChoice(choice);
              }}
              lineWrapping={lineWrapping}
              onLineWrapping={(enabled) => {
                preferences.lineWrapping.set(enabled);
                setLineWrapping(enabled);
                editor.current?.setLineWrapping(enabled);
              }}
              onInsertSnippet={(s) => {
                editor.current?.insertSnippet(s.body);
                setSheet(null);
                setTab("code");
              }}
            />
          </Modal>
        ) : null}
      </main>

      <Controls
        hidden={showPicker}
        method={dictationMethod}
        listening={listening}
        hasSpeech={hasSpeech}
        showTyped={showTyped}
        replying={replying}
        onSay={(text) => enqueue(text)}
        onTalkStart={talk.start}
        onTalkEnd={() => void talk.stop()}
        onUndo={() => editor.current?.undo()}
        onRedo={() => editor.current?.redo()}
        onRun={() => setSheet(sheet === "run" ? null : "run")}
        keyboard={keyboard}
        onToggleKeyboard={toggleKeyboard}
      />
    </div>
  );
}
