import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  type Bootstrap,
  type DayMeta,
  type Problem,
  type Puzzle,
  type Tab,
  type Turn,
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
import { EMPTY_META, sampleInput, withSuggestions } from "./samples";
import { debounced, type FileVersion, LatestSaver, type SaveStatus, VersionedSaver } from "./saver";
import { DiscussView } from "./views/discuss";
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
import { PushToTalk, speechSupported, speechUnavailableReason } from "./voice";
import {
  keepScreenOnPreference,
  ScreenWakeLock,
  setKeepScreenOnPreference,
  wakeLockSupported,
} from "./wakelock";

type Sheet = "run" | "settings" | null;

interface Feedback {
  kind: "pending" | "ok" | "warn" | "error" | "info";
  transcript?: string;
  text: string;
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const discussKey = (p: Puzzle) => `workshop:discuss:${p.year}:${p.day}`;

function loadTurns(p: Puzzle): Turn[] {
  try {
    const raw = localStorage.getItem(discussKey(p));
    return raw ? (JSON.parse(raw) as Turn[]) : [];
  } catch {
    return [];
  }
}

export function App({ boot }: { boot: Bootstrap }) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(boot.state.puzzle);
  const [tab, setTab] = useState<Tab>(boot.state.tab);
  const [discussModel, setDiscussModel] = useState(
    boot.state.discuss_model && boot.discuss_models.includes(boot.state.discuss_model)
      ? boot.state.discuss_model
      : (boot.discuss_models[0] ?? ""),
  );
  const [sheet, setSheet] = useState<Sheet>(null);
  const [picking, setPicking] = useState(false);

  const [openError, setOpenError] = useState<string | null>(null);
  const [meta, setMeta] = useState<DayMeta>(EMPTY_META);
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [problemLoading, setProblemLoading] = useState(false);

  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState("");
  const [diagnostics, setDiagnostics] = useState<Diagnostics>({ errors: 0, warnings: 0 });
  const [hover, setHover] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [codeConflict, setCodeConflict] = useState<FileVersion | null>(null);
  const [notesConflict, setNotesConflict] = useState<FileVersion | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [run, setRun] = useState<RunState>(initialRunState);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

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
  const fileUri = useRef<string | null>(null);
  const metaRef = useRef(meta);
  const puzzleRef = useRef(puzzle);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const ptt = useMemo(() => new PushToTalk(), []);
  const listeningRef = useRef(false);
  const hasSpeech = useMemo(speechSupported, []);
  const [keepScreenOn, setKeepScreenOn] = useState(keepScreenOnPreference);
  const wakeLock = useMemo(() => new ScreenWakeLock(), []);
  useEffect(() => () => wakeLock.dispose(), [wakeLock]);
  useEffect(() => wakeLock.setEnabled(keepScreenOn), [wakeLock, keepScreenOn]);
  // Typing commands is handy at a desk, and the only option without speech recognition.
  const showTyped = useMemo(
    () => !hasSpeech || window.matchMedia("(pointer: fine)").matches,
    [hasSpeech],
  );
  // Queued utterances run after later renders, so they read the latest state through refs.
  const latest = useRef({ tab, notes, turns, run });
  latest.current = { tab, notes, turns, run };
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
    setTurns(loadTurns(puzzle));
    setDiscussError(null);

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

  const part = problem ? (problem.answers.length >= 2 ? null : problem.answers.length + 1) : 1;
  const expected = part === null ? null : (meta.sample_answers[part - 1] ?? null);

  const doRun = async (input: InputKind) => {
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
      try {
        await saver.current?.flush();
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
        void doRun(command.input);
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
    }
  };

  const doEdit = async (utterance: string) => {
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
    setFeedback({ kind: "pending", transcript: utterance, text: "Editing…" });
    try {
      const result = await api.edit(marked, utterance, current.recentInsertion);
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
        current.applyMarked(result.doc);
        setFeedback({ kind: "ok", transcript: utterance, text: `${result.summary} · ${seconds}` });
      } else {
        setFeedback({ kind: "warn", transcript: utterance, text: result.message });
      }
    } catch (e) {
      api.log("error", `edit ${JSON.stringify(utterance)}: ${message(e)}`);
      setFeedback({ kind: "error", transcript: utterance, text: message(e) });
    }
  };

  const sendDiscuss = async (text: string) => {
    const p = puzzleRef.current;
    if (!p) return;
    const next: Turn[] = [...latest.current.turns, { speaker: "user", text }];
    latest.current.turns = next;
    setTurns(next);
    localStorage.setItem(discussKey(p), JSON.stringify(next));
    setThinking(true);
    setDiscussError(null);
    const last = latest.current.run.last;
    try {
      const reply = await api.discuss({
        year: p.year,
        day: p.day,
        model: discussModel,
        turns: next,
        code: editor.current?.text() ?? "",
        errors: editor.current?.diagnosticsText() ?? "",
        last_run: last
          ? `${last.input} input: ${describeEnding(last.result)}\nstdout:\n${last.result.stdout}\nstderr:\n${last.result.stderr}`
          : "",
      });
      if (puzzleRef.current !== p) return;
      const withReply: Turn[] = [...next, { speaker: "coach", text: reply.text }];
      latest.current.turns = withReply;
      setTurns(withReply);
      localStorage.setItem(discussKey(p), JSON.stringify(withReply));
    } catch (e) {
      setDiscussError(message(e));
    } finally {
      setThinking(false);
    }
  };

  const handleUtterance = async (text: string) => {
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
      await sendDiscuss(text);
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
    await doEdit(text);
  };

  // Utterances are handled one at a time, in the order they were spoken.
  const enqueue = (text: string) => {
    queue.current = queue.current.then(() => handleUtterance(text));
  };

  const startTalking = (event: PointerEvent) => {
    event.preventDefault();
    if (listeningRef.current) return;
    try {
      (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
      ptt.start(setInterim, editor.current?.identifiers() ?? []);
      listeningRef.current = true;
      setListening(true);
      setInterim("");
      navigator.vibrate?.(10);
    } catch (e) {
      setFeedback({ kind: "error", text: message(e) });
    }
  };

  const stopTalking = async () => {
    if (!listeningRef.current) return;
    listeningRef.current = false;
    setListening(false);
    try {
      const text = await ptt.stop();
      setInterim("");
      if (text.trim()) {
        enqueue(text.trim());
      } else {
        api.log("speech", "(nothing heard)");
        setFeedback({ kind: "info", text: "Didn't catch anything." });
      }
    } catch (e) {
      api.log("error", `speech recognition: ${message(e)}`);
      setFeedback({ kind: "error", text: message(e) });
    }
  };

  const submitTyped = (event: Event) => {
    event.preventDefault();
    const text = typed.trim();
    if (!text) return;
    setTyped("");
    enqueue(text);
  };

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

  const stars = problem ? "★".repeat(problem.answers.length) : "";
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
              ‹ Back to {puzzle.year} · day {puzzle.day}
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
            {puzzle ? `${puzzle.year} · day ${puzzle.day}` : ""}
            {stars ? <span class="stars"> {stars}</span> : null}
          </button>
        )}
        <button
          type="button"
          class="icon-button"
          aria-label="Settings"
          onClick={() => setSheet(sheet === "settings" ? null : "settings")}
        >
          ⚙
        </button>
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
            <Picker
              current={puzzle}
              hasSession={boot.has_aoc_session}
              onPick={(p) => {
                setPicking(false);
                if (!puzzle || p.year !== puzzle.year || p.day !== puzzle.day) {
                  setPuzzle(p);
                  setTab("problem");
                }
              }}
            />
          </div>
        ) : null}
        {openError && !showPicker ? <p class="pane error-text">{openError}</p> : null}
        {codeConflict && !showPicker ? (
          <ConflictBanner what="code" onResolve={resolveCodeConflict} />
        ) : null}
        {notesConflict && !showPicker ? (
          <ConflictBanner what="notes" onResolve={resolveNotesConflict} />
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
            problem={problem}
            error={problemError}
            loading={problemLoading}
            meta={meta}
            onMeta={updateMeta}
            onRefresh={() => puzzle && void loadProblem(puzzle, true)}
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
            turns={turns}
            models={boot.discuss_models}
            model={discussModel}
            thinking={thinking}
            error={discussError}
            onModel={setDiscussModel}
            onSend={(text) => enqueue(text)}
            onClear={() => {
              setTurns([]);
              if (puzzle) localStorage.removeItem(discussKey(puzzle));
            }}
          />
        ) : null}
        {sheet ? (
          <SheetFrame title={sheet === "run" ? "Run" : "Settings"} onClose={() => setSheet(null)}>
            {sheet === "run" ? (
              <RunSheet
                state={run}
                part={part}
                expected={expected}
                onRun={(input) => void doRun(input)}
                onCancel={() => void api.cancelRun()}
                onAskSubmit={() => setRun((r) => ({ ...r, confirmSubmit: true }))}
                onSubmit={(answer) => void doSubmit(answer)}
                onDismissSubmit={() => setRun((r) => ({ ...r, confirmSubmit: false }))}
              />
            ) : null}
            {sheet === "settings" ? (
              <Settings
                snippets={boot.snippets}
                editModel={boot.edit_model}
                commitMessage={
                  puzzle ? `Advent of Code ${puzzle.year} day ${puzzle.day}` : "Advent of Code"
                }
                keepScreenOn={wakeLockSupported() ? keepScreenOn : null}
                onKeepScreenOn={(enabled) => {
                  setKeepScreenOnPreference(enabled);
                  setKeepScreenOn(enabled);
                }}
                onInsertSnippet={(s) => {
                  editor.current?.insertSnippet(s.body);
                  setSheet(null);
                  setTab("code");
                }}
              />
            ) : null}
          </SheetFrame>
        ) : null}
      </main>

      <footer class={`controls ${showPicker ? "hidden" : ""}`}>
        <div class={`feedback ${feedback?.kind ?? ""}`} aria-live="polite">
          {listening ? (
            <span class="transcript">{interim || "Listening…"}</span>
          ) : feedback ? (
            <>
              {feedback.transcript ? <span class="transcript">“{feedback.transcript}”</span> : null}
              <span class="result">{feedback.text}</span>
            </>
          ) : (
            <span class="muted">
              {hasSpeech ? "Hold to talk. Edits apply at the cursor." : speechUnavailableReason()}
            </span>
          )}
        </div>
        {showTyped ? (
          <form class="typed" onSubmit={submitTyped}>
            <input
              value={typed}
              onInput={(e) => setTyped((e.target as HTMLInputElement).value)}
              placeholder="Type what you'd say"
              enterKeyHint="send"
            />
          </form>
        ) : null}
        <div class="buttons">
          <button
            type="button"
            class="round"
            aria-label="Undo"
            onClick={() => editor.current?.undo()}
          >
            ↶
          </button>
          <button
            type="button"
            class="round"
            aria-label="Redo"
            onClick={() => editor.current?.redo()}
          >
            ↷
          </button>
          <button
            type="button"
            class={`talk ${listening ? "listening" : ""}`}
            disabled={!hasSpeech}
            onPointerDown={startTalking}
            onPointerUp={() => void stopTalking()}
            onPointerCancel={() => void stopTalking()}
            onContextMenu={(e) => e.preventDefault()}
          >
            {listening ? "Release to send" : "Hold to talk"}
          </button>
          <button
            type="button"
            class="round"
            aria-label="Run"
            onClick={() => setSheet(sheet === "run" ? null : "run")}
          >
            ▶
          </button>
          <button
            type="button"
            class={`round ${keyboard ? "selected" : ""}`}
            aria-label={keyboard ? "Hide keyboard" : "Type"}
            onClick={toggleKeyboard}
          >
            ⌨
          </button>
        </div>
      </footer>
    </div>
  );
}

function ConflictBanner({
  what,
  onResolve,
}: {
  what: string;
  onResolve: (keep: "mine" | "theirs") => void;
}) {
  return (
    <div class="banner">
      <span>The {what} changed elsewhere.</span>
      <span class="banner-actions">
        <button type="button" class="text-button" onClick={() => onResolve("mine")}>
          Keep mine
        </button>
        <button type="button" class="text-button" onClick={() => onResolve("theirs")}>
          Load theirs
        </button>
      </span>
    </div>
  );
}

function SheetFrame({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="sheet">
      <div class="sheet-header">
        <h1>{title}</h1>
        <button type="button" class="icon-button" aria-label="Close" onClick={onClose}>
          ✕
        </button>
      </div>
      <div class="sheet-body">{children}</div>
    </div>
  );
}
