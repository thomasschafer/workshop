import type { LSPClient } from "@codemirror/lsp-client";
import type { ComponentChildren } from "preact";
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  type Bootstrap,
  type CodeFile,
  type DayMeta,
  type Problem,
  type Puzzle,
  type Tab,
  type Turn,
} from "./api";
import { type LocalCommand, matchCommand } from "./commands";
import { CodeEditor, connectLanguageServer, type Diagnostics, hoverText } from "./editor";
import { CodeSaver, debounced, type SaveStatus } from "./saver";
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

type Sheet = "run" | "picker" | "settings" | null;

interface Feedback {
  kind: "pending" | "ok" | "warn" | "error" | "info";
  transcript?: string;
  text: string;
}

const EMPTY_META: DayMeta = {
  sample_block: null,
  sample_input: null,
  sample_answers: [null, null],
  cursor: null,
};

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

/** Fills in the sample input and expected answers from the puzzle's likely candidates. */
function withSuggestions(meta: DayMeta, problem: Problem): DayMeta {
  let next = meta;
  const block = problem.suggested_sample_blocks[0];
  if (next.sample_block === null && block !== null && block !== undefined) {
    next = { ...next, sample_block: block, sample_input: problem.blocks[block] ?? null };
  }
  const answers: [string | null, string | null] = [...next.sample_answers];
  let changed = false;
  for (const i of [0, 1] as const) {
    const suggestion = problem.suggested_sample_answers[i];
    if (answers[i] === null && suggestion) {
      answers[i] = suggestion;
      changed = true;
    }
  }
  return changed ? { ...next, sample_answers: answers } : next;
}

export function App({ boot }: { boot: Bootstrap }) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(boot.state.puzzle);
  const [tab, setTab] = useState<Tab>(boot.state.tab);
  const [discussModel, setDiscussModel] = useState(
    boot.state.discuss_model && boot.discuss_models.includes(boot.state.discuss_model)
      ? boot.state.discuss_model
      : (boot.discuss_models[0] ?? ""),
  );
  const [sheet, setSheet] = useState<Sheet>(boot.state.puzzle ? null : "picker");

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
  const [conflict, setConflict] = useState<CodeFile | null>(null);
  const [keyboard, setKeyboard] = useState(false);
  const [run, setRun] = useState<RunState>(initialRunState);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [thinking, setThinking] = useState(false);
  const [discussError, setDiscussError] = useState<string | null>(null);
  const [typed, setTyped] = useState("");

  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditor | null>(null);
  const saver = useRef<CodeSaver | null>(null);
  const lsp = useRef<LSPClient | null>(null);
  const fileUri = useRef<string | null>(null);
  const metaRef = useRef(meta);
  const puzzleRef = useRef(puzzle);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const ptt = useMemo(() => new PushToTalk(), []);
  const listeningRef = useRef(false);
  const hasSpeech = useMemo(speechSupported, []);
  // Typing commands is handy at a desk, and the only option without speech recognition.
  const showTyped = useMemo(
    () => !hasSpeech || window.matchMedia("(pointer: fine)").matches,
    [hasSpeech],
  );
  // Queued utterances run after later renders, so they read the latest state through refs.
  const latest = useRef({ tab, notes, turns, run });
  latest.current = { tab, notes, turns, run };
  puzzleRef.current = puzzle;

  const saveMetaSoon = useMemo(
    () =>
      debounced(({ p, m }: { p: Puzzle; m: DayMeta }) => {
        api
          .saveMeta(p, m)
          .catch((e) => setFeedback({ kind: "error", text: `Couldn't save: ${message(e)}` }));
      }, 600),
    [],
  );
  const updateMeta = useCallback(
    (next: DayMeta) => {
      metaRef.current = next;
      setMeta(next);
      if (puzzleRef.current) saveMetaSoon({ p: puzzleRef.current, m: next });
    },
    [saveMetaSoon],
  );

  const saveNotesSoon = useMemo(
    () =>
      debounced(({ p, text }: { p: Puzzle; text: string }) => {
        api
          .saveNotes(p, text)
          .catch((e) => setFeedback({ kind: "error", text: `Couldn't save notes: ${message(e)}` }));
      }, 500),
    [],
  );
  const updateNotes = (text: string) => {
    latest.current.notes = text;
    setNotes(text);
    if (puzzle) saveNotesSoon({ p: puzzle, text });
  };

  // Remember where the user is, so a reload reopens the same view.
  const saveStateSoon = useMemo(() => debounced(api.saveState, 500), []);
  useEffect(() => {
    saveStateSoon({ puzzle, tab, discuss_model: discussModel });
  }, [puzzle, tab, discussModel, saveStateSoon]);

  const lookUpType = useMemo(
    () =>
      debounced((pos: number) => {
        const client = lsp.current;
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
    setConflict(null);
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
        setNotes(opened.notes);
        void loadProblem(puzzle, false);

        if (boot.language.has_lsp && !lsp.current) {
          try {
            lsp.current = await connectLanguageServer(boot.language.root_uri, () => {
              lsp.current = null;
            });
          } catch (e) {
            setFeedback({ kind: "warn", text: `Language server unavailable: ${message(e)}` });
          }
          if (cancelled) return;
        }

        const host = editorHost.current;
        if (!host) return;
        fileUri.current = opened.file_uri;
        const codeSaver = new CodeSaver(puzzle, opened.code.version, setSaveStatus, setConflict);
        saver.current = codeSaver;
        editor.current = new CodeEditor(host, {
          doc: opened.code.text,
          cursor: opened.meta.cursor,
          mode: boot.language.editor_mode,
          lsp: lsp.current
            ? {
                client: lsp.current,
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
        setSaveStatus("saved");
      } catch (e) {
        if (!cancelled) setOpenError(message(e));
      }
    })();

    return () => {
      cancelled = true;
      saver.current?.flushOnExit();
      saver.current?.stop();
      saver.current = null;
      editor.current?.destroy();
      editor.current = null;
    };
  }, [puzzle, boot, loadProblem, updateMeta, lookUpType]);

  // Save when the phone is put down, and pick up changes made at a desk when it comes back.
  useEffect(() => {
    const onHide = () => saver.current?.flushOnExit();
    const onVisibility = async () => {
      if (document.visibilityState === "hidden") {
        onHide();
        return;
      }
      const p = puzzleRef.current;
      const current = editor.current;
      if (!p || !current || saveStatus !== "saved") return;
      try {
        const opened = await api.open(p);
        if (opened.code.text !== current.text()) {
          current.replaceAll(opened.code.text);
          saver.current?.resume(opened.code.version);
          setFeedback({ kind: "info", text: "Loaded changes made elsewhere." });
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
  }, [saveStatus]);

  const part = problem ? (problem.answers.length >= 2 ? null : problem.answers.length + 1) : 1;
  const expected = part === null ? null : (meta.sample_answers[part - 1] ?? null);

  const doRun = async (input: InputKind) => {
    const p = puzzleRef.current;
    if (!p) return;
    setSheet("run");
    if (input === "sample" && !metaRef.current.sample_input) {
      setRun((r) => ({
        ...r,
        error: "Choose the sample input first: tap a code block in the puzzle.",
      }));
      return;
    }
    setRun((r) => ({ ...r, running: input, error: null, submitted: null, confirmSubmit: false }));
    try {
      await saver.current?.flush();
      const result = await api.run(p, input);
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

  const takeDiskVersion = () => {
    if (!conflict) return;
    editor.current?.replaceAll(conflict.text);
    saver.current?.resume(conflict.version);
    setConflict(null);
  };

  const stars = problem ? "★".repeat(problem.answers.length) : "";
  const statusParts: string[] = [];
  if (boot.language.has_lsp) {
    statusParts.push(
      diagnostics.errors || diagnostics.warnings
        ? `${diagnostics.errors} error${diagnostics.errors === 1 ? "" : "s"}${diagnostics.warnings ? `, ${diagnostics.warnings} warning${diagnostics.warnings === 1 ? "" : "s"}` : ""}`
        : "no errors",
    );
  }
  if (saveStatus === "error") statusParts.push("not saved");
  else if (saveStatus !== "saved" && saveStatus !== "conflict") statusParts.push("saving");

  return (
    <div class="app">
      <header class="top">
        <button
          type="button"
          class="puzzle-button"
          onClick={() => setSheet(sheet === "picker" ? null : "picker")}
        >
          {puzzle ? `${puzzle.year} · day ${puzzle.day}` : "Choose a puzzle"}
          {stars ? <span class="stars"> {stars}</span> : null}
        </button>
        <button
          type="button"
          class="icon-button"
          aria-label="Settings"
          onClick={() => setSheet(sheet === "settings" ? null : "settings")}
        >
          ⚙
        </button>
      </header>

      <nav class="tabs">
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
        {openError ? <p class="pane error-text">{openError}</p> : null}
        {conflict ? (
          <div class="banner">
            This file changed on disk.
            <button type="button" class="text-button" onClick={takeDiskVersion}>
              Load it
            </button>
          </div>
        ) : null}
        <div class={`code-pane ${tab === "code" ? "" : "hidden"}`}>
          <div class="status-line">
            <span>{statusParts.join(" · ")}</span>
            {hover ? <code class="hover">{hover}</code> : null}
          </div>
          <div class="editor" ref={editorHost} />
        </div>
        {tab === "problem" ? (
          <ProblemView
            problem={problem}
            error={problemError}
            loading={problemLoading}
            meta={meta}
            onMeta={updateMeta}
            onRefresh={() => puzzle && void loadProblem(puzzle, true)}
          />
        ) : null}
        {tab === "notes" ? (
          <div class="pane notes">
            <textarea
              value={notes}
              onInput={(e) => updateNotes((e.target as HTMLTextAreaElement).value)}
              placeholder="Rough thoughts. Hold the button to dictate."
            />
          </div>
        ) : null}
        {tab === "discuss" ? (
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
          <SheetFrame
            title={sheet === "run" ? "Run" : sheet === "picker" ? "Puzzles" : "Settings"}
            onClose={() => setSheet(null)}
          >
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
            {sheet === "picker" ? (
              <Picker
                current={puzzle}
                hasSession={boot.has_aoc_session}
                onPick={(p) => {
                  setSheet(null);
                  if (!puzzle || p.year !== puzzle.year || p.day !== puzzle.day) {
                    setPuzzle(p);
                    setTab("problem");
                  }
                }}
              />
            ) : null}
            {sheet === "settings" ? (
              <Settings
                snippets={boot.snippets}
                editModel={boot.edit_model}
                commitMessage={
                  puzzle ? `Advent of Code ${puzzle.year} day ${puzzle.day}` : "Advent of Code"
                }
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

      <footer class="controls">
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
