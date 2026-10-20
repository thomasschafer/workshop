import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, type Bootstrap, loginNeeded, type Problem, type Puzzle, type Tab } from "./api";
import { type LocalCommand, matchCommand } from "./commands";
import { CodeEditor, type Diagnostics, hoverText } from "./editor";
import { errorMessage } from "./errors";
import { useConnection } from "./hooks/useConnection";
import { useDayMeta } from "./hooks/useDayMeta";
import { useDictation } from "./hooks/useDictation";
import { useDiscussion } from "./hooks/useDiscussion";
import { type UtteranceDetail, useEditing } from "./hooks/useEditing";
import { useFileSync } from "./hooks/useFileSync";
import { useLanguageServer } from "./hooks/useLanguageServer";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePackages } from "./hooks/usePackages";
import { usePartTwoOffer } from "./hooks/usePartTwoOffer";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { usePuzzleOffers } from "./hooks/usePuzzleOffers";
import { useRun } from "./hooks/useRun";
import { useSampleFinding } from "./hooks/useSampleFinding";
import { useTalkKey } from "./hooks/useTalkKey";
import { useUiStateSaver } from "./hooks/useUiStateSaver";
import { findMissingModule, isUpToDate } from "./packages";
import * as preferences from "./preferences";
import { isPractice, PRACTICE, puzzleTitle } from "./puzzle";
import { sampleInput, withSuggestions } from "./samples";
import { debounced, type FileVersion, type SaveStatus, VersionedSaver } from "./saver";
import {
  done,
  type Job,
  type JobContext,
  type Outcome,
  type Card as UtteranceCard,
  UtteranceQueue,
  warn,
} from "./utterances";
import { SpeechBench } from "./views/bench";
import { Controls } from "./views/controls";
import { DiscussView } from "./views/discuss";
import { ConflictBanner } from "./views/frame";
import { Header, Tabs } from "./views/header";
import { Help } from "./views/help";
import { Modal } from "./views/modal";
import { MissingPackageBanner, OutdatedPackagesBanner } from "./views/packages";
import { Picker } from "./views/picker";
import { ProblemView } from "./views/problem";
import { describeEnding, initialRunState, RunSheet } from "./views/run";
import { Settings } from "./views/settings";
import { Setup } from "./views/setup";
import { Stack } from "./views/stack";
import { StatusLine } from "./views/status";
import { speechUnavailableReason } from "./voice";
import { ScreenWakeLock, wakeLockSupported } from "./wakelock";

type Sheet = "run" | "settings" | "help" | "setup" | "bench" | null;

/** The space kept clear below the code for the cards floating over it. */
const insetFor = (stackHeight: number) => (stackHeight > 0 ? stackHeight + 16 : 0);

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

  const editorHost = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditor | null>(null);
  // Utterances spoken while a puzzle's editor is still loading wait for it.
  const editorWaiters = useRef<((editor: CodeEditor) => void)[]>([]);
  const stackHeightRef = useRef(0);
  const saver = useRef<VersionedSaver | null>(null);
  const notesSaver = useRef<VersionedSaver | null>(null);
  const { lsp, lspStatus } = useLanguageServer(boot, editor);
  const fileUri = useRef<string | null>(null);
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
  const { meta, setMeta, metaRef, metaSavers, updateMeta } = useDayMeta(puzzleRef, notify);
  const { findingSamples, setFindingSamples, findSamples } = useSampleFinding(
    puzzleRef,
    metaRef,
    updateMeta,
  );
  /** Null until the open puzzle's code has loaded. */
  const [part2Started, setPart2Started] = useState<boolean | null>(null);
  const part = problem ? (problem.stars >= 2 ? null : problem.stars + 1) : 1;
  // The part being worked on: the next one to solve, or for a solved puzzle being worked through
  // again, the one the code has got to.
  const workingPart = part ?? (part2Started === true ? 2 : 1);
  const { run, setRun, doRun, doSubmit } = useRun({
    puzzleRef,
    part,
    workingPart,
    metaRef,
    metaSavers,
    saver,
    queue,
    setSheet,
    setProblem,
    updateMeta,
    findSamples,
    notify,
  });
  const { question, setQuestion, replying, setReplying, doEdit, enqueue } = useEditing({
    queue,
    editor,
    puzzleRef,
    editorWaiters,
  });
  // Offered once until it's done, however many requests find Advent of Code needs a login.
  const loginOffered = useRef(false);
  useEffect(
    () =>
      loginNeeded.subscribe((message) => {
        if (loginOffered.current) return;
        loginOffered.current = true;
        queue.offer(message, "Log in", () => {
          loginOffered.current = false;
          setSheet("setup");
        });
      }),
    [],
  );
  const [keepScreenOn, setKeepScreenOn] = useState(() => preferences.keepScreenOn.get());
  const [lineWrapping, setLineWrapping] = useState(() => preferences.lineWrapping.get());
  /** Whether code has started part 2: the template's part 2 line is no longer turned off. */
  const hasStartedPart2 = (text: string) => {
    const swap = boot.language.start_part_two;
    return swap === null || !text.includes(swap.find);
  };
  const [leaderboard, setLeaderboard] = useState(boot.leaderboard);
  const [commitAfterStar, setCommitAfterStar] = useState(boot.commit_after_star);
  const wakeLock = useMemo(() => new ScreenWakeLock(), []);
  useEffect(() => () => wakeLock.dispose(), [wakeLock]);
  useEffect(() => wakeLock.setEnabled(keepScreenOn), [wakeLock, keepScreenOn]);
  // Queued utterances run after later renders, so they read the latest state through refs.
  const latest = useRef({ tab: shownTab, notes, run });
  latest.current = { tab: shownTab, notes, run };
  puzzleRef.current = puzzle;

  const updateNotes = (text: string) => {
    latest.current.notes = text;
    setNotes(text);
    notesSaver.current?.schedule(text);
  };

  const stateSaver = useUiStateSaver({ puzzle, tab, discuss_model: discussModel });

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
        void findSamples(p, loaded);
      } catch (e) {
        if (puzzleRef.current === p) setProblemError(errorMessage(e));
      } finally {
        if (puzzleRef.current === p) setProblemLoading(false);
      }
    },
    [updateMeta, findSamples],
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
    setPart2Started(null);
    setFindingSamples([]);

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
        const doc = codeSaver.recover();
        setPart2Started(hasStartedPart2(doc));
        const created = new CodeEditor(host, {
          doc,
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
          onChange: (text) => {
            codeSaver.schedule(text);
            setPart2Started(hasStartedPart2(text));
          },
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
        if (!cancelled) setOpenError(errorMessage(e));
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

  useFileSync({
    puzzleRef,
    editor,
    saver,
    notesSaver,
    metaSavers,
    stateSaver,
    notify,
    onNotes: (text) => {
      latest.current.notes = text;
      setNotes(text);
    },
  });

  usePartTwoOffer(queue, puzzle, part, part2Started, () => {
    const started = startPartTwo();
    if (started.kind === "problem") notify(started.tone, started.text);
  });
  const expected = meta.sample_answers[workingPart - 1] ?? null;

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
  usePuzzleOffers(queue, puzzleRef, openPuzzle);

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

  /** Turns on the template's part 2 code, such as by uncommenting the line printing its answer. */
  const startPartTwo = (): Outcome => {
    const swap = boot.language.start_part_two;
    if (!swap) return warn(`${boot.language.name} has nothing to turn on for part 2.`);
    const current = editor.current;
    if (!current) return warn("Open a puzzle first.");
    if (!current.swapText(swap.find, swap.replace)) {
      return warn("Part 2's line isn't there to uncomment; it may be on already.");
    }
    setTab("code");
    return done("Started part 2");
  };

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
      case "startPartTwo":
        return startPartTwo();
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

  const {
    dictationChoice,
    setDictationChoice,
    setServerSpeech,
    hasSpeech,
    dictationSupport,
    dictationMethod,
  } = useDictation(boot.server_dictation);
  const talk = usePushToTalk({
    method: () => (dictationMethod === "server" ? "server" : "browser"),
    vocabulary: () => editor.current?.identifiers() ?? [],
    onStart: () => queue.reserveId(),
    onUtterance: (id, text, pieces) => enqueue(text, pieces, id),
    onNotice: notify,
  });
  // Keeps the code clear of the cards floating over its bottom edge.
  useEffect(() => {
    stackHeightRef.current = stackHeight;
    editor.current?.setBottomInset(insetFor(stackHeight));
  }, [stackHeight]);
  useEffect(() => {
    if (!hasSpeech && !dictationSupport.server) notify("warn", speechUnavailableReason());
  }, []);
  // Typing commands is handy at a desk, and the only option without a way to hold and talk.
  const showTyped = useMemo(
    () => dictationMethod === "keyboard" || window.matchMedia("(pointer: fine)").matches,
    [dictationMethod],
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

  // The picker is the home screen until a puzzle is open, and can be reopened from the header.
  const showPicker = picking || puzzle === null;
  // The talk button's state, and where it's hidden, apply to the Ctrl key just the same.
  const controlsHidden = showPicker || shownTab === "problem";
  useTalkKey(dictationMethod !== "keyboard" && !controlsHidden && sheet === null, talk);

  const problemView = puzzle ? (
    <ProblemView
      puzzle={puzzle}
      problem={problem}
      error={problemError}
      loading={problemLoading}
      meta={meta}
      onMeta={updateMeta}
      findingSamples={findingSamples}
      onRefresh={() => puzzle && void loadProblem(puzzle, true)}
      onStartAgain={
        puzzle && isPractice(puzzle)
          ? () => {
              api
                .resetPractice()
                .then(setProblem)
                .catch((e: unknown) => setProblemError(errorMessage(e)));
            }
          : null
      }
    />
  ) : null;
  const split = wide && !showPicker && problemView !== null;

  return (
    <div class={`app ${split ? "split" : ""}`}>
      <Header
        showPicker={showPicker}
        puzzle={puzzle}
        stars={stars}
        onBack={() => setPicking(false)}
        onPick={() => {
          setSheet(null);
          setPicking(true);
        }}
        onHelp={() => setSheet(sheet === "help" ? null : "help")}
        onSettings={() => setSheet(sheet === "settings" ? null : "settings")}
      />
      {split ? <aside class="side">{problemView}</aside> : null}

      <Tabs hidden={showPicker} wide={wide} shown={shownTab} onTab={setTab} />

      <main class="content" style={{ "--stack-height": `${stackHeight}px` }}>
        <Stack
          cards={cards}
          live={talk.live}
          onCancelLive={talk.cancel}
          replyingTo={replying ? (question?.card ?? null) : null}
          onAct={(id) => queue.act(id)}
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
          <StatusLine
            checks={lsp ? lspStatus : null}
            diagnostics={diagnostics}
            saveStatus={saveStatus}
            hover={hover}
          />
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
              onLoggedIn={() => {
                loginOffered.current = false;
                setHasSession(true);
              }}
              onServerSpeech={setServerSpeech}
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
              workingPart={workingPart}
              expected={expected}
              accepted={problem?.answers ?? []}
              onRun={(input) => void doRun(input, true)}
              onCancel={() => void api.cancelRun()}
              onAskSubmit={() => setRun((r) => ({ ...r, confirmSubmit: true }))}
              onSubmit={(answer) => void doSubmit(answer)}
              onDismissSubmit={() => setRun((r) => ({ ...r, confirmSubmit: false }))}
              finalStar={problem?.final_star ?? null}
              hasSample={sampleInput(meta, workingPart === 1 ? 0 : 1) !== null}
              onClaimFinalStar={() => void doSubmit("0")}
            />
          </Modal>
        ) : null}
        {sheet === "settings" ? (
          <Settings
            onClose={() => setSheet(null)}
            snippets={boot.snippets}
            models={models}
            onModels={setModels}
            onSetup={() => setSheet("setup")}
            onBench={() => setSheet("bench")}
            commitAfterStar={commitAfterStar}
            onCommitAfterStar={(enabled) => {
              setCommitAfterStar(enabled);
              api.setSolutionsRepo(enabled).catch((e: unknown) => {
                setCommitAfterStar(!enabled);
                notify("error", `Couldn't change that: ${errorMessage(e)}`);
              });
            }}
            commitMessage={puzzle ? puzzleTitle(puzzle) : "Advent of Code"}
            solutionsDir={boot.solutions_dir}
            leaderboard={leaderboard}
            update={boot.update}
            onLeaderboard={async (id) => {
              await api.setLeaderboard(id);
              setLeaderboard(id);
            }}
            keepScreenOn={wakeLockSupported() ? keepScreenOn : null}
            onKeepScreenOn={(enabled) => {
              preferences.keepScreenOn.set(enabled);
              setKeepScreenOn(enabled);
            }}
            packages={packages}
            dictation={{
              choice: dictationChoice,
              method: dictationMethod,
              support: dictationSupport,
            }}
            onServerSpeech={setServerSpeech}
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
        ) : null}
      </main>

      <Controls
        // Nothing to do with them while reading the puzzle: speech would edit code out of sight.
        hidden={controlsHidden}
        method={dictationMethod}
        talk={talk.held}
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
