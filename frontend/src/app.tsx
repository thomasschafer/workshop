import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  type Bootstrap,
  type DayMeta,
  type Exchange,
  type Problem,
  type Puzzle,
  type Tab,
  type UiState,
} from "./api";
import { type LocalCommand, matchCommand } from "./commands";
import {
  CodeEditor,
  type Diagnostics,
  hoverText,
  LanguageServerConnection,
  type LanguageServerStatus,
} from "./editor";
import type { Feedback } from "./feedback";
import { useDiscussion } from "./hooks/useDiscussion";
import { usePackages } from "./hooks/usePackages";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { findMissingModule, isUpToDate } from "./packages";
import * as preferences from "./preferences";
import { isPractice, PRACTICE, puzzleLabel, puzzleTitle } from "./puzzle";
import { EMPTY_META, sampleInput, withSuggestions } from "./samples";
import { debounced, type FileVersion, LatestSaver, type SaveStatus, VersionedSaver } from "./saver";
import { Controls } from "./views/controls";
import { DiscussView } from "./views/discuss";
import { ConflictBanner, SheetFrame } from "./views/frame";
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
import { ScreenWakeLock, wakeLockSupported } from "./wakelock";

type Sheet = "run" | "settings" | "help" | "setup" | null;

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

export function App({ boot }: { boot: Bootstrap }) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(boot.state.puzzle);
  const [tab, setTab] = useState<Tab>(boot.state.tab);
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

  const [feedback, setFeedback] = useState<Feedback | null>(null);
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
  // The edit model's latest question, with the requests that led to it, and whether the user
  // has chosen to reply to it rather than start afresh.
  const [question, setQuestion] = useState<Exchange[] | null>(null);
  const [replying, setReplying] = useState(false);

  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditor | null>(null);
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
  const queue = useRef<Promise<void>>(Promise.resolve());
  const [keepScreenOn, setKeepScreenOn] = useState(() => preferences.keepScreenOn.get());
  const [lineWrapping, setLineWrapping] = useState(() => preferences.lineWrapping.get());
  const wakeLock = useMemo(() => new ScreenWakeLock(), []);
  useEffect(() => () => wakeLock.dispose(), [wakeLock]);
  useEffect(() => wakeLock.setEnabled(keepScreenOn), [wakeLock, keepScreenOn]);
  // Queued utterances run after later renders, so they read the latest state through refs.
  const latest = useRef({ tab, notes, run, question, replying });
  latest.current = { tab, notes, run, question, replying };
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
        (e) => setFeedback({ kind: "error", text: `Couldn't save, retrying: ${e}` }),
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
              setFeedback({ kind: "error", text: `Couldn't save notes, retrying: ${detail}` });
            }
          },
          setNotesConflict,
        );
        notesSaver.current = notes;
        const notesText = notes.recover();
        latest.current.notes = notesText;
        setNotes(notesText);
        editor.current = new CodeEditor(host, {
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
          setFeedback({ kind: "info", text: "Loaded code changed elsewhere." });
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
      if (waitForEdits) await queue.current;
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

  const installPackage = async (pkg: string, transcript?: string) => {
    const said = transcript === undefined ? {} : { transcript };
    setFeedback({ kind: "info", ...said, text: `Installing ${pkg}…` });
    const installed = await packages.add(pkg);
    setFeedback(
      installed
        ? { kind: "ok", ...said, text: `Installed ${pkg}` }
        : { kind: "error", ...said, text: `Couldn't install ${pkg}; see Settings, Packages.` },
    );
  };

  const runCommand = (command: LocalCommand, transcript: string) => {
    const current = editor.current;
    const done = (text: string) => setFeedback({ kind: "ok", transcript, text });
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
        return setFeedback({ kind: "warn", transcript, text: "Run on the real input first." });
      case "gotoLine":
        setTab("code");
        return current?.gotoLine(command.line)
          ? done(`Line ${command.line}`)
          : setFeedback({ kind: "warn", transcript, text: `There's no line ${command.line}.` });
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
        if (snippet && current) {
          current.insertSnippet(snippet.body);
          return done(`Inserted ${snippet.name}`);
        }
        return;
      }
      case "tab":
        setTab(command.tab);
        return done(`Showing ${command.tab}`);
      case "install": {
        if (boot.language.packages === null) {
          return setFeedback({
            kind: "warn",
            transcript,
            text: `${boot.language.name} has no packages to install.`,
          });
        }
        if (command.package !== null) {
          void installPackage(command.package, transcript);
          return;
        }
        if (missing === null) {
          return setFeedback({
            kind: "warn",
            transcript,
            text: "Say which package, like “install package split”.",
          });
        }
        void (async () => {
          const found = missing.package ?? (await packageFor(missing.module));
          if (found === null) {
            setFeedback({
              kind: "warn",
              transcript,
              text: `Couldn't find a package for ${missing.module}; add it in Settings, under Packages.`,
            });
          } else {
            await installPackage(found, transcript);
          }
        })();
        return;
      }
    }
  };

  const doEdit = async (utterance: string, earlier: Exchange[]) => {
    const current = editor.current;
    if (!current) {
      setFeedback({ kind: "warn", transcript: utterance, text: "Open a puzzle first." });
      return;
    }
    let marked: string;
    try {
      marked = current.markedText();
    } catch (e) {
      setFeedback({ kind: "error", transcript: utterance, text: message(e) });
      return;
    }
    const before = current.text();
    setFeedback({ kind: "pending", transcript: utterance, startedAt: performance.now() });
    try {
      const result = await api.edit(marked, utterance, current.recentInsertion, earlier);
      if (editor.current !== current || current.text() !== before) {
        setFeedback({
          kind: "warn",
          transcript: utterance,
          text: "The code changed while I was thinking, so I left it alone.",
        });
        return;
      }
      const seconds = `${(result.elapsed_ms / 1000).toFixed(1)}s`;
      if (result.status === "applied") {
        current.applyMarked(result.doc, result.inserted);
        setQuestion(null);
        const model = result.model ? ` · ${result.model.replace(/^claude-/, "")}` : "";
        setFeedback({
          kind: "ok",
          transcript: utterance,
          text: `${result.summary} · ${seconds}${model}`,
        });
      } else {
        setQuestion([...earlier, { said: utterance, asked: result.message }]);
        setFeedback({ kind: "warn", transcript: utterance, text: result.message });
      }
    } catch (e) {
      api.log("error", `edit ${JSON.stringify(utterance)}: ${message(e)}`);
      setFeedback({ kind: "error", transcript: utterance, text: message(e) });
    }
  };

  const handleUtterance = async (text: string, earlier: Exchange[] | null) => {
    if (earlier) {
      // A reply to the edit model's question, wherever it was spoken from.
      api.log("speech", `reply: ${text}`);
      await doEdit(text, earlier);
      return;
    }
    const { tab, notes } = latest.current;
    if (tab === "notes") {
      api.log("speech", `notes: ${text}`);
      updateNotes(notes ? `${notes.replace(/\s*$/, "")}\n${text}` : text);
      setFeedback({ kind: "ok", transcript: text, text: "Added to notes" });
      return;
    }
    if (tab === "discuss") {
      api.log("speech", `discuss: ${text}`);
      setFeedback(null);
      await discussion.send(text);
      return;
    }
    const command = matchCommand(
      text,
      boot.snippets.map((s) => s.name),
    );
    if (command) {
      api.log("command", `${JSON.stringify(text)} -> ${JSON.stringify(command)}`);
      runCommand(command, text);
      return;
    }
    setQuestion(null);
    await doEdit(text, []);
  };

  // Utterances are handled one at a time, in the order they were spoken.
  const enqueue = (text: string) => {
    const { replying, question } = latest.current;
    const earlier = replying && question ? question : null;
    setReplying(false);
    // Each utterance handles its own errors; this catches any it misses, so one failure can't
    // stop every later utterance, or a run waiting for them.
    queue.current = queue.current
      .then(() => handleUtterance(text, earlier))
      .catch((e: unknown) => {
        api.log("error", `utterance ${JSON.stringify(text)}: ${message(e)}`);
        setFeedback({ kind: "error", transcript: text, text: message(e) });
      });
  };

  const talk = usePushToTalk({
    vocabulary: () => editor.current?.identifiers() ?? [],
    onUtterance: enqueue,
    onFeedback: setFeedback,
  });
  const { hasSpeech, listening, interim } = talk;
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

  return (
    <div class="app">
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

      <nav class={`tabs ${showPicker ? "hidden" : ""}`}>
        {(["problem", "code", "notes", "discuss"] as const).map((t) => (
          <button
            type="button"
            key={t}
            class={t === tab ? "selected" : ""}
            onClick={() => setTab(t)}
          >
            {t === "discuss" ? "Discuss" : t[0]?.toUpperCase() + t.slice(1)}
          </button>
        ))}
      </nav>

      <main class="content">
        {showPicker ? (
          <div class="pane">
            <Picker current={puzzle} hasSession={hasSession} onPick={openPuzzle} />
          </div>
        ) : null}
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
        <div class={`code-pane ${tab === "code" && !showPicker ? "" : "hidden"}`}>
          <div class="status-line">
            <span>{statusParts.join(" · ")}</span>
            {hover ? <code class="hover">{hover}</code> : null}
          </div>
          <div class="editor" ref={editorHost} />
        </div>
        {!showPicker && tab === "problem" ? (
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
        ) : null}
        {!showPicker && tab === "notes" ? (
          <div class="pane notes">
            <textarea
              value={notes}
              onInput={(e) => updateNotes((e.target as HTMLTextAreaElement).value)}
              placeholder="Rough thoughts. Hold the button to dictate."
            />
          </div>
        ) : null}
        {!showPicker && tab === "discuss" ? (
          <DiscussView
            turns={discussion.turns}
            models={models.discuss_models}
            model={discussModel}
            thinking={discussion.thinking}
            error={discussion.error}
            onModel={setDiscussModel}
            onSend={(text) => enqueue(text)}
            onClear={discussion.clear}
          />
        ) : null}
        {sheet === "setup" ? (
          <Modal title="Set up Workshop" onClose={() => setSheet(null)} full>
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
        {sheet === "help" ? (
          <Modal title="How Workshop works" onClose={() => setSheet(null)} full>
            <Help />
          </Modal>
        ) : null}
        {sheet === "run" ? (
          <SheetFrame title="Run" onClose={() => setSheet(null)}>
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
          </SheetFrame>
        ) : null}
        {sheet === "settings" ? (
          <Modal title="Settings" onClose={() => setSheet(null)} full>
            <Settings
              snippets={boot.snippets}
              models={models}
              onModels={setModels}
              onSetup={() => setSheet("setup")}
              commitMessage={puzzle ? puzzleTitle(puzzle) : "Advent of Code"}
              keepScreenOn={wakeLockSupported() ? keepScreenOn : null}
              onKeepScreenOn={(enabled) => {
                preferences.keepScreenOn.set(enabled);
                setKeepScreenOn(enabled);
              }}
              packages={packages}
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
        feedback={feedback}
        listening={listening}
        interim={interim}
        hasSpeech={hasSpeech}
        showTyped={showTyped}
        question={question}
        replying={replying}
        onReplying={setReplying}
        onSay={enqueue}
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
