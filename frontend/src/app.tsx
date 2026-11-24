import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import {
  api,
  type Bootstrap,
  ConnectionError,
  connection,
  isTransientNetworkError,
  loginNeeded,
  type OpenPuzzle,
  type Problem,
  type Puzzle,
  type Tab,
  TimeoutError,
} from "./api";
import { type LocalCommand, matchCommand } from "./commands";
import { CodeEditor, type Diagnostics, type HelixSetup, hoverText, NO_DIAGNOSTICS } from "./editor";
import { errorMessage } from "./errors";
import { describeProblems } from "./helix/config";
import { useCodeKeyboard } from "./hooks/useCodeKeyboard";
import { useConnection } from "./hooks/useConnection";
import { useDayMeta } from "./hooks/useDayMeta";
import { useDictation } from "./hooks/useDictation";
import { useDiscussion } from "./hooks/useDiscussion";
import { type UtteranceDetail, useEditing } from "./hooks/useEditing";
import { useEditorSettings } from "./hooks/useEditorSettings";
import { useFileSync } from "./hooks/useFileSync";
import { useLanguageServer } from "./hooks/useLanguageServer";
import { useMediaQuery } from "./hooks/useMediaQuery";
import { usePackages } from "./hooks/usePackages";
import { usePartTwoOffer } from "./hooks/usePartTwoOffer";
import { usePushToTalk } from "./hooks/usePushToTalk";
import { usePuzzleOffers } from "./hooks/usePuzzleOffers";
import { useRun } from "./hooks/useRun";
import { useSampleFinding } from "./hooks/useSampleFinding";
import { useShortcuts } from "./hooks/useShortcuts";
import { useUiStateSaver } from "./hooks/useUiStateSaver";
import { getAocPuzzle, getHelpers, mergeAocPuzzle, putHelpers } from "./offline/db";
import { refreshCachedBundles } from "./onDevice/bundles";
import { findMissingModule, isUpToDate } from "./packages";
import * as preferences from "./preferences";
import { isPractice, PRACTICE, puzzleTitle } from "./puzzle";
import { EMPTY_META, sampleInput, withSuggestions } from "./samples";
import { debounced, type FileVersion, type SaveStatus, VersionedSaver } from "./saver";
import { watchSwipes } from "./swipe";
import { turnTab } from "./tabTurn";
import type { Destination } from "./tracks/types";
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
import { Calibrate } from "./views/calibrate";
import { Controls } from "./views/controls";
import { DiscussView } from "./views/discuss";
import { ConflictBanner } from "./views/frame";
import { Header, TABS, Tabs, tabBeside } from "./views/header";
import { Help } from "./views/help";
import { CodeKeyboard } from "./views/keyboard";
import { Modal } from "./views/modal";
import { MissingPackageBanner, OutdatedPackagesBanner } from "./views/packages";
import { Picker } from "./views/picker";
import { ProblemView } from "./views/problem";
import { ProblemsSheet } from "./views/problems";
import { describeEnding, initialRunState, RunSheet } from "./views/run";
import { Settings } from "./views/settings";
import { Setup } from "./views/setup";
import { ShortcutsModal } from "./views/shortcuts";
import { Stack } from "./views/stack";
import { StatusLine } from "./views/status";
import { TypingBench } from "./views/typingBench";
import { useZen, ZenExit, ZenKeyboardButton, ZenTabs } from "./views/zen";
import { speechUnavailableReason } from "./voice";
import { ScreenWakeLock, wakeLockSupported } from "./wakelock";

type Sheet =
  | "run"
  | "settings"
  | "help"
  | "setup"
  | "bench"
  | "calibrate"
  | "typing-bench"
  | "problems"
  | "shortcuts"
  | null;

/** FNV-1a version of an empty file, matching `workshop_common::files::version_of("")`. */
const EMPTY_FILE_VERSION = "cbf29ce484222325";

/** The space kept clear below the code for the cards floating over it. */
const insetFor = (stackHeight: number) => (stackHeight > 0 ? stackHeight + 16 : 0);

export function App({
  boot,
  entry,
  onHome,
}: {
  boot: Bootstrap;
  /** Where to open: at a puzzle or the list of them, or else where the app was last left. */
  entry: Destination | null;
  /** Goes to the home screen, saying where Advent of Code was left, to come back to. */
  onHome: (left: Destination) => void;
}) {
  const [puzzle, setPuzzle] = useState<Puzzle | null>(
    entry?.kind === "puzzle" ? entry.puzzle : boot.state.puzzle,
  );
  const [tab, setTab] = useState<Tab>(boot.state.tab);
  // On a wide screen the puzzle has a column of its own, beside the other tabs.
  const wide = useMediaQuery("(min-width: 1000px)");
  const online = useConnection();
  const zenMode = useZen((text) => notify("warn", text));
  const zen = zenMode.on;
  // In zen mode the puzzle has no column, so it's a tab there on any screen.
  const split = wide && !zen;
  const shownTab: Tab = split && tab === "problem" ? "code" : tab;
  const [models, setModels] = useState(boot.models);
  const [chosenDiscussModel, setDiscussModel] = useState(boot.state.discuss_model);
  // The chosen discussion model, if the current provider offers it, or its first model.
  const discussModel =
    chosenDiscussModel && models.discuss_models.includes(chosenDiscussModel)
      ? chosenDiscussModel
      : (models.discuss_models[0] ?? "");
  const [sheet, setSheet] = useState<Sheet>(boot.needs_setup ? "setup" : null);
  const [hasSession, setHasSession] = useState(boot.has_aoc_session);
  const [picking, setPicking] = useState(entry?.kind === "puzzle_list");

  const [openError, setOpenError] = useState<string | null>(null);
  const [notes, setNotes] = useState("");
  const [problem, setProblem] = useState<Problem | null>(null);
  const [problemFromCache, setProblemFromCache] = useState(false);
  const [problemError, setProblemError] = useState<string | null>(null);
  const [problemLoading, setProblemLoading] = useState(false);

  const [cards, setCards] = useState<UtteranceCard[]>([]);
  const [stackHeight, setStackHeight] = useState(0);
  const [diagnostics, setDiagnostics] = useState<Diagnostics>(NO_DIAGNOSTICS);
  const [hover, setHover] = useState<string | null>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("saved");
  const [codeConflict, setCodeConflict] = useState<FileVersion | null>(null);
  const [notesConflict, setNotesConflict] = useState<FileVersion | null>(null);
  const packages = usePackages(boot.language.packages !== null);
  const discussion = useDiscussion(puzzle, discussModel, () => {
    const last = latest.current.run.last;
    return {
      code: editor.current?.text() ?? "",
      notes: latest.current.notes,
      errors: editor.current?.diagnosticsText() ?? "",
      lastRun: last
        ? `${last.input} input: ${describeEnding(last.result)}\nstdout:\n${last.result.stdout}\nstderr:\n${last.result.stderr}`
        : "",
    };
  });

  const editorHost = useRef<HTMLDivElement>(null);
  const codePane = useRef<HTMLDivElement>(null);
  const editor = useRef<CodeEditor | null>(null);
  // Shown in the tap rather than on the next render, so the editor can take the focus.
  const keyboard = useCodeKeyboard(editor, () => {
    setTab("code");
    codePane.current?.classList.remove("hidden");
  });
  // Utterances spoken while a puzzle's editor is still loading wait for it.
  const editorWaiters = useRef<((editor: CodeEditor) => void)[]>([]);
  const stackHeightRef = useRef(0);
  const saver = useRef<VersionedSaver | null>(null);
  const notesSaver = useRef<VersionedSaver | null>(null);
  const [keepScreenOn, setKeepScreenOn] = useState(() => preferences.keepScreenOn.get());
  const [onDeviceMode, setOnDeviceMode] = useState(() => preferences.onDeviceMode.get());
  useEffect(() => {
    void refreshCachedBundles();
  }, []);
  const {
    lsp,
    lspStatus,
    lspBackend,
    lspError,
    lspUnavailable,
    dismissLspError,
    restartLsp,
    retryLsp,
    reconnectServerLsp,
  } = useLanguageServer(
    boot.language.has_lsp
      ? {
          rootUri: boot.language.root_uri,
          options: boot.language.lsp_options,
          path: "/api/lsp",
          languageId: boot.language.id,
          mode: onDeviceMode,
        }
      : null,
    `${boot.language.id}:${boot.language.root_uri}:${onDeviceMode}`,
    editor,
  );
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
  const { meta, initMeta, metaRef, metaSavers, updateMeta } = useDayMeta(puzzleRef, notify);
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
  const { run, setRun, doRun, cancelRun, doSubmit } = useRun({
    puzzleRef,
    part,
    workingPart,
    languageId: boot.language.id,
    onDeviceMode,
    online,
    editor,
    metaRef,
    metaSavers,
    saver,
    queue,
    setSheet,
    setProblem,
    updateMeta,
    findSamples,
    notify,
    formatBeforeRun: () => editor.current?.formatBeforeRun() ?? Promise.resolve(),
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
  const settings = useEditorSettings(boot.editor, editor);
  const {
    lineWrapping,
    changeLineWrapping,
    codeScale,
    changeCodeScale,
    helixOn,
    helix,
    touchScreen,
    ownKeyboard,
    keyOffsets,
  } = settings;
  /** Helix's keybindings for the open file, or null if they're off. */
  const helixSetup = (documentName: string): HelixSetup | null =>
    settings.helixSetup(documentName, {
      write: async () => {
        await saver.current?.flush();
      },
      reload: async () => {
        const p = puzzleRef.current;
        const s = saver.current;
        const current = editor.current;
        if (!p || !s || !current) return;
        // Changes here are saved first, so reloading only ever picks up changes made
        // elsewhere.
        await s.flush();
        const mark = s.readMark();
        const opened = await api.open(p);
        if (s.adopt(opened.code, mark)) current.replaceAll(opened.code.text);
      },
      showProblems: () => setSheet("problems"),
      restartLanguageServer: restartLsp,
    });
  const helixSetupRef = useRef(helixSetup);
  helixSetupRef.current = helixSetup;
  useEffect(() => {
    const problems = describeProblems(helix.problems);
    if (helixOn && problems) notify("error", problems);
  }, [helix, helixOn]);
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
  // The tab being turned to, until the page shows it.
  const turningTo = useRef<Tab | null>(null);
  if (turningTo.current === tab) turningTo.current = null;
  const latest = useRef({ tab: shownTab, notes, run });
  latest.current = { tab: turningTo.current ?? shownTab, notes, run };
  puzzleRef.current = puzzle;

  const updateNotes = (text: string) => {
    latest.current.notes = text;
    setNotes(text);
    notesSaver.current?.schedule(text);
  };

  const stateSaver = useUiStateSaver({ puzzle, tab, discuss_model: discussModel });
  // Leaving for the home screen, which goes by where the app was left.
  useEffect(() => () => stateSaver.flushOnExit(), [stateSaver]);

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
        setProblemFromCache(false);
        void mergeAocPuzzle(p.year, p.day, { problem: loaded });
        const suggested = withSuggestions(metaRef.current, loaded);
        if (suggested !== metaRef.current) updateMeta(suggested);
        void findSamples(p, loaded);
      } catch (e) {
        if (!refresh && (e instanceof ConnectionError || e instanceof TimeoutError)) {
          const cached = await getAocPuzzle(p.year, p.day);
          if (puzzleRef.current !== p) return;
          if (cached?.problem) {
            setProblem(cached.problem);
            setProblemFromCache(true);
            return;
          }
        }
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
    setProblemFromCache(false);
    setOpenError(null);
    setRun(initialRunState);
    setCodeConflict(null);
    setNotesConflict(null);
    setSaveStatus("saved");
    setDiagnostics(NO_DIAGNOSTICS);
    setHover(null);
    setPart2Started(null);
    setFindingSamples([]);

    (async () => {
      try {
        let opened: OpenPuzzle;
        let fromOfflineCache = false;
        const cachedBeforeOpen = await getAocPuzzle(puzzle.year, puzzle.day);
        if (cancelled) return;
        const browserOffline =
          !connection.isOnline || (typeof navigator !== "undefined" && navigator.onLine === false);
        const openFromCache = (cached: typeof cachedBeforeOpen): OpenPuzzle | null => {
          if (!cached?.code) return null;
          fromOfflineCache = true;
          if (cached.problem) {
            setProblem(cached.problem);
            setProblemFromCache(true);
          }
          return {
            code: cached.code,
            notes: cached.notes ?? { text: "", version: EMPTY_FILE_VERSION, path: "" },
            meta: cached.meta ?? EMPTY_META,
            file_uri: cached.fileUri ?? "",
          };
        };

        if (browserOffline && cachedBeforeOpen?.code) {
          opened = openFromCache(cachedBeforeOpen) as OpenPuzzle;
        } else {
          try {
            // When we already have a local copy, use a tighter timeout so a blackholed VPN falls
            // back to the cached puzzle within 3s instead of hanging for 8s.
            opened = await api.open(
              puzzle,
              cachedBeforeOpen?.code ? { timeoutMs: 3_000 } : undefined,
            );
            if (cancelled) return;
            void mergeAocPuzzle(puzzle.year, puzzle.day, {
              code: opened.code,
              notes: opened.notes,
              meta: opened.meta,
              fileUri: opened.file_uri,
            });
            // Quietly cache the puzzle's input and shared helpers on-device for offline use.
            if (cachedBeforeOpen?.input === undefined) {
              api
                .input(puzzle)
                .then((inp) => mergeAocPuzzle(puzzle.year, puzzle.day, { input: inp.text }))
                .catch(() => {});
            }
            void getHelpers(boot.language.id).then((existing) => {
              if (!existing) {
                api
                  .helpers()
                  .then((h) => (h ? putHelpers(h.language_id, h.file, h.text) : undefined))
                  .catch(() => {});
              }
            });
          } catch (openErr) {
            if (!isTransientNetworkError(openErr)) {
              throw openErr;
            }
            connection.set(false);
            const cached = cachedBeforeOpen ?? (await getAocPuzzle(puzzle.year, puzzle.day));
            if (cancelled) return;
            const fallback = openFromCache(cached);
            if (!fallback) {
              setOpenError(
                "This puzzle isn't saved on this device yet. Open it once while connected, or save a year for offline use from the puzzle list.",
              );
              return;
            }
            opened = fallback;
          }
        }

        if (cancelled) return;
        initMeta(puzzle, opened.meta);
        if (!fromOfflineCache) void loadProblem(puzzle, false);

        const host = editorHost.current;
        if (!host) return;
        fileUri.current = opened.file_uri;
        const key = `${puzzle.year}-${puzzle.day}`;
        const codeSaver = new VersionedSaver(
          async (text, version, keepalive) => {
            const saved = await api.saveCode(puzzle, text, version, keepalive);
            void mergeAocPuzzle(puzzle.year, puzzle.day, { code: saved });
            return saved;
          },
          `workshop:unsaved:code:${key}`,
          opened.code.version,
          opened.code.text,
          setSaveStatus,
          setCodeConflict,
        );
        saver.current = codeSaver;
        const notes = new VersionedSaver(
          async (text, version, keepalive) => {
            const saved = await api.saveNotes(puzzle, text, version, keepalive);
            void mergeAocPuzzle(puzzle.year, puzzle.day, { notes: saved });
            return saved;
          },
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
          ...settings.editorOptions(),
          helix: helixSetupRef.current(fileName(opened.file_uri)),
          formatter: boot.language.has_formatter ? (code) => api.format(puzzle, code) : null,
          formatAutomatically: boot.editor.format_automatically,
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
          onDiagnostics: setDiagnostics,
        });
        created.setBottomInset(insetFor(stackHeightRef.current));
        created.setStatusHost(keyboard.statusHost.current);
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
  }, [puzzle, boot, lsp, loadProblem, initMeta, updateMeta, lookUpType]);

  // Once back online, refresh a puzzle page that was loaded from cache so part 2 appears if solved.
  useEffect(() => {
    if (online && problemFromCache && puzzle) {
      void loadProblem(puzzle, false);
    }
  }, [online, problemFromCache, puzzle, loadProblem]);

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

  const enterZen = () => {
    setSheet(null);
    // In the tap itself, as phones only open the keyboard for something the user started.
    keyboard.show(true);
    zenMode.enter();
  };
  // Turning between tabs by a sweep or a shortcut slides the one that's left out as the next
  // comes in, the way it's turned. Not by tapping a tab: while a tab slides in it takes no
  // touches, and a tap on what's just been turned to shouldn't be lost. The page only changes
  // once the browser is ready to slide, a moment later, so what happens next, such as something
  // said or another turn, goes by the tab being turned to.
  const turnTo = (next: Tab) => {
    // Beside the code, the puzzle isn't a tab to turn to.
    if (split && next === "problem") return;
    const from = TABS.indexOf(latest.current.tab);
    const to = TABS.indexOf(next);
    if (to === from) return;
    turningTo.current = next;
    latest.current.tab = next;
    turnTab(to > from ? "forward" : "back", () => setTab(next));
  };
  const turnBy = (direction: 1 | -1) => turnTo(tabBeside(latest.current.tab, direction));
  const turnByRef = useRef(turnBy);
  turnByRef.current = turnBy;

  // In zen mode the tabs are hidden, so on a touch screen two fingers swept sideways turn to the
  // next one, or back. The keyboard, if it's up, goes while the code isn't showing, and comes
  // back with it.
  // As zen mode is entered, rather than once the page has next been drawn, so no sweep is missed.
  // On the whole page: while one tab slides to the next, touches on it land on what's behind.
  useLayoutEffect(() => {
    if (!zen || !touchScreen) return;
    return watchSwipes(document.documentElement, ".keyboard, .modal-backdrop", (direction) =>
      turnByRef.current(direction === "left" ? 1 : -1),
    );
  }, [zen, touchScreen]);

  const exitZen = zenMode.exit;

  // With a dialog open, only the shortcut that lists the shortcuts works, to show or hide them.
  const puzzleOpen = puzzle !== null && !picking && (sheet === null || sheet === "run");
  const quiet = sheet === null;
  useShortcuts({
    runSample: puzzleOpen ? () => void doRun("sample", true) : null,
    runReal: puzzleOpen ? () => void doRun("real", true) : null,
    zen: puzzleOpen && quiet ? () => (zen ? exitZen() : enterZen()) : null,
    nextTab: puzzleOpen && quiet ? () => turnBy(1) : null,
    previousTab: puzzleOpen && quiet ? () => turnBy(-1) : null,
    save: puzzleOpen
      ? () => {
          Promise.all([saver.current?.flush(), notesSaver.current?.flush()]).then(
            () => notify("ok", "Saved"),
            (e: unknown) => {
              if (!connection.isOnline || isTransientNetworkError(e)) {
                notify("info", "Saved on this device; will sync when online.");
                return;
              }
              notify("error", `Couldn't save: ${errorMessage(e)}`);
            },
          );
        }
      : null,
    nextProblem:
      puzzleOpen && quiet
        ? () => {
            setTab("code");
            editor.current?.nextError();
          }
        : null,
    previousProblem:
      puzzleOpen && quiet
        ? () => {
            setTab("code");
            editor.current?.previousError();
          }
        : null,
    shortcuts:
      sheet === null || sheet === "shortcuts"
        ? () => setSheet(sheet === "shortcuts" ? null : "shortcuts")
        : null,
  });

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

  // Saved first, so the home screen goes by what was just done here.
  const goHome = () => {
    const left: Destination =
      picking || puzzle === null ? { kind: "puzzle_list" } : { kind: "puzzle", puzzle };
    void Promise.allSettled([
      saver.current?.flush(),
      notesSaver.current?.flush(),
      stateSaver.flush(),
    ]).then(() => onHome(left));
  };

  // The picker is the home screen until a puzzle is open, and can be reopened from the header.
  const showPicker = picking || puzzle === null;
  // Only for the code, and in place of the controls, which lowering it brings back.
  const keyboardShown = ownKeyboard && keyboard.wanted && shownTab === "code" && !showPicker;
  const controlsHidden = showPicker || shownTab === "problem" || zen || keyboardShown;

  const problemView = puzzle ? (
    <ProblemView
      puzzle={puzzle}
      problem={problem}
      fromCache={problemFromCache}
      error={problemError}
      loading={problemLoading}
      meta={meta}
      onMeta={updateMeta}
      findingSamples={findingSamples}
      hidden={!split && (showPicker || shownTab !== "problem")}
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
  const sideBySide = split && !showPicker && problemView !== null;

  return (
    <div class={`app ${sideBySide ? "split" : ""} ${zen ? "zen" : ""}`}>
      <Header
        showPicker={showPicker}
        puzzle={puzzle}
        stars={stars}
        onBack={() => setPicking(false)}
        onHome={goHome}
        onPick={() => {
          setSheet(null);
          setPicking(true);
        }}
        onZen={showPicker ? null : enterZen}
        onHelp={() => setSheet(sheet === "help" ? null : "help")}
        onSettings={() => setSheet(sheet === "settings" ? null : "settings")}
      />
      {sideBySide ? <aside class="side">{problemView}</aside> : null}

      <Tabs hidden={showPicker} wide={split} shown={shownTab} onTab={setTab} />

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
        {zen ? <ZenExit onExit={exitZen} /> : null}
        {zen ? <ZenTabs shown={shownTab} /> : null}
        {showPicker ? (
          <div class="pane">
            <Picker current={puzzle} hasSession={hasSession} onPick={openPuzzle} />
          </div>
        ) : null}
        {online ? null : (
          <div class="banner offline" role="status">
            Offline · changes saved on this device
          </div>
        )}
        {openError && !showPicker ? (
          <div class="pane">
            <p class="error-text">{openError}</p>
            <button type="button" class="text-button" onClick={() => setPicking(true)}>
              Choose a cached puzzle
            </button>
          </div>
        ) : null}
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
        <div
          ref={codePane}
          class={`code-pane ${shownTab === "code" && !showPicker ? "" : "hidden"}`}
        >
          {zen && ownKeyboard && !keyboard.wanted ? (
            <ZenKeyboardButton onClick={() => keyboard.show(true)} />
          ) : null}
          <StatusLine
            checks={lsp ? lspStatus : null}
            backend={lsp ? lspBackend : undefined}
            online={online}
            unavailable={lspUnavailable}
            onRetry={retryLsp}
            serverError={lspError !== null}
            diagnostics={diagnostics}
            saveStatus={saveStatus}
            hover={hover}
            showProblem={!helixOn}
            onProblems={() => setSheet("problems")}
          />
          <div class="editor" ref={editorHost} />
        </div>
        {sideBySide ? null : problemView}
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
            unanswered={discussion.unanswered}
            draft={discussion.draft}
            onDraft={discussion.setDraft}
            onModel={setDiscussModel}
            onSend={(text) => enqueue(text)}
            onRetry={() => void discussion.retry()}
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
        {sheet === "calibrate" ? (
          <Calibrate onUse={keyOffsets.replace} onClose={() => setSheet(null)} />
        ) : null}
        {sheet === "typing-bench" ? (
          <TypingBench offsets={keyOffsets.offsets} onClose={() => setSheet(null)} />
        ) : null}
        {sheet === "problems" ? (
          <ProblemsSheet
            problems={editor.current?.problems() ?? []}
            current={diagnostics.atCursor}
            server={
              lsp ? { error: lspError, onDismiss: dismissLspError, onRestart: restartLsp } : null
            }
            backend={lsp ? lspBackend : undefined}
            onReconnectServer={lsp && lspBackend === "local" ? reconnectServerLsp : undefined}
            onGoto={(problem) => {
              editor.current?.gotoProblem(problem);
              setSheet(null);
            }}
            onClose={() => setSheet(null)}
          />
        ) : null}
        {sheet === "help" ? (
          <Modal title="How Workshop works" onClose={() => setSheet(null)} shape="full">
            <Help onShortcuts={() => setSheet("shortcuts")} />
          </Modal>
        ) : null}
        {sheet === "shortcuts" ? (
          <ShortcutsModal helixOn={helixOn} onClose={() => setSheet(null)} />
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
              onCancel={cancelRun}
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
            ownKeyboard={ownKeyboard ? keyOffsets : null}
            onCalibrate={() => setSheet("calibrate")}
            onTypingBench={() => setSheet("typing-bench")}
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
            onLineWrapping={changeLineWrapping}
            codeScale={codeScale}
            onCodeScale={changeCodeScale}
            helixOn={helixOn}
            helixProblems={describeProblems(helix.problems)}
            onHelix={(enabled) => {
              settings.setHelixOn(enabled);
              const uri = fileUri.current;
              editor.current?.setHelix(uri ? helixSetupRef.current(fileName(uri)) : null);
            }}
            onDevice={{
              mode: onDeviceMode,
              onMode: (mode) => {
                preferences.onDeviceMode.set(mode);
                setOnDeviceMode(mode);
              },
              languageId: boot.language.id,
              languageName: boot.language.name,
              hasLsp: boot.language.has_lsp,
              lspBackend: lsp ? lspBackend : undefined,
              hasFormatter: boot.language.has_formatter,
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
        // Workshop's own keyboard only shows for the code, so elsewhere the button brings it up.
        keyboard={ownKeyboard ? keyboardShown : keyboard.wanted}
        onToggleKeyboard={() => keyboard.show(ownKeyboard ? !keyboardShown : !keyboard.wanted)}
      />
      {keyboardShown ? (
        <CodeKeyboard
          editor={editor}
          keyOffsets={keyOffsets}
          onLower={() => keyboard.show(false)}
          statusHost={keyboard.placeStatus}
        />
      ) : null}
    </div>
  );
}

/** The file's name, from its URI. */
function fileName(uri: string): string {
  return decodeURIComponent(uri.slice(uri.lastIndexOf("/") + 1));
}
