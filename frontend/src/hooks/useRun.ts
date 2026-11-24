import type { RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import { api, type DayMeta, isTransientNetworkError, type Problem, type Puzzle } from "../api";
import type { CodeEditor } from "../editor";
import { errorMessage } from "../errors";
import { newId } from "../learning/local";
import { getAocPuzzle, getHelpers, mergeAocPuzzle } from "../offline/db";
import { localRunner, resolveRunBackend } from "../onDevice/runner";
import type { OnDeviceMode } from "../preferences";
import { sampleInput, withSuggestions } from "../samples";
import type { LatestSaver, VersionedSaver } from "../saver";
import { type InputKind, initialRunState, type RunState } from "../views/run";

interface Options {
  puzzleRef: RefObject<Puzzle | null>;
  /** The next part to solve, or null once both are. */
  part: number | null;
  /** The part being worked on, whose sample is run. */
  workingPart: number;
  languageId: string;
  onDeviceMode: OnDeviceMode;
  online: boolean;
  editor: RefObject<CodeEditor | null>;
  metaRef: RefObject<DayMeta>;
  metaSavers: RefObject<Map<string, LatestSaver<DayMeta>>>;
  saver: RefObject<VersionedSaver | null>;
  /** Waits for the utterances still being handled. */
  queue: { idle: () => Promise<void> };
  setSheet: (sheet: "run") => void;
  setProblem: (problem: Problem) => void;
  updateMeta: (next: DayMeta) => void;
  findSamples: (p: Puzzle, loaded: Problem) => Promise<void>;
  notify: (tone: "info" | "error", text: string) => void;
  /** Formats the code, if that's done automatically, so what's run is formatted. */
  formatBeforeRun: () => Promise<void>;
}

/** Running the solution and submitting its answer, and what the Run sheet shows of them. */
export function useRun({
  puzzleRef,
  part,
  workingPart,
  languageId,
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
  formatBeforeRun,
}: Options) {
  const [run, setRun] = useState<RunState>(initialRunState);
  const activeRun = useRef<{
    id: string;
    controller: AbortController;
    source: "server" | "local";
  } | null>(null);

  /**
   * Runs the solution. From the Run sheet it first waits for edits still being made from
   * earlier utterances, so it runs what was said; a spoken "run" is already queued after them.
   */
  const doRun = async (input: InputKind, waitForEdits: boolean) => {
    const p = puzzleRef.current;
    if (!p) return;
    setSheet("run");
    const runPart = workingPart;
    const chosenSample =
      input === "sample" ? sampleInput(metaRef.current, runPart === 1 ? 0 : 1) : null;
    if (input === "sample" && chosenSample === null) {
      setRun((r) => ({
        ...r,
        error: "Choose the sample input first: tap a code block in the puzzle.",
      }));
      return;
    }
    setRun((r) => ({ ...r, running: input, error: null, submitted: null, confirmSubmit: false }));
    activeRun.current?.controller.abort();
    const runId = newId();
    const controller = new AbortController();

    // Decide server vs on-device up front from connection liveness + navigator.onLine.
    const hasLocal = await localRunner().isAvailable(languageId);
    const effectivelyOnline =
      online && (typeof navigator === "undefined" || navigator.onLine !== false);
    const backend = resolveRunBackend(onDeviceMode, effectivelyOnline, hasLocal);
    activeRun.current = { id: runId, controller, source: backend };

    const runLocally = async () => {
      activeRun.current = { id: runId, controller, source: "local" };
      // Flush locally buffered edits without failing when offline.
      void saver.current?.flush().catch(() => {});
      const code = editor.current?.text() ?? "";
      let stdin: string;
      if (input === "sample") {
        stdin = chosenSample ?? "";
      } else {
        const cached = await getAocPuzzle(p.year, p.day);
        if (cached?.input !== undefined) {
          stdin = cached.input;
        } else if (effectivelyOnline) {
          const fetched = await api.input(p);
          stdin = fetched.text;
          void mergeAocPuzzle(p.year, p.day, { input: fetched.text });
        } else {
          setRun((r) => ({
            ...r,
            running: null,
            error:
              "This puzzle's real input isn't cached offline yet. Open it while online to save it.",
          }));
          return;
        }
      }
      const cachedHelper = await getHelpers(languageId);
      const helpers = cachedHelper
        ? [
            {
              name: cachedHelper.file.split("/").pop() ?? cachedHelper.file,
              text: cachedHelper.text,
            },
          ]
        : undefined;
      const { result, engine } = await localRunner().runAoc({
        languageId,
        code,
        stdin,
        helpers,
        signal: controller.signal,
      });
      if (!controller.signal.aborted) {
        setRun((r) => ({
          ...r,
          running: null,
          last: { input, result, source: "local", engine },
        }));
      } else {
        setRun((r) => ({ ...r, running: null }));
      }
    };

    try {
      if (waitForEdits) await queue.idle();
      if (backend === "local") {
        await runLocally();
        return;
      }

      await formatBeforeRun();
      try {
        // The run reads the code and the chosen sample from the server.
        await saver.current?.flush();
        await metaSavers.current.get(`${p.year}-${p.day}`)?.flush();
      } catch (e) {
        if (isTransientNetworkError(e) && onDeviceMode === "automatic" && hasLocal) {
          await runLocally();
          return;
        }
        setRun((r) => ({ ...r, running: null, error: `Not run: ${errorMessage(e)}` }));
        return;
      }
      try {
        const result = await api.run(p, input, runPart, runId, controller.signal);
        setRun((r) => ({ ...r, running: null, last: { input, result, source: "server" } }));
      } catch (e) {
        if (
          !controller.signal.aborted &&
          isTransientNetworkError(e) &&
          onDeviceMode === "automatic" &&
          hasLocal
        ) {
          await runLocally();
          return;
        }
        throw e;
      }
    } catch (e) {
      if (controller.signal.aborted) {
        if (activeRun.current?.source === "server") {
          // Best-effort server cancel scoped by runId so run_lock is released without killing a
          // newer run if this cancel arrives late.
          api.cancelRun(runId).catch(() => {});
        }
        setRun((r) => ({ ...r, running: null }));
      } else {
        setRun((r) => ({ ...r, running: null, error: errorMessage(e) }));
      }
    } finally {
      if (activeRun.current?.id === runId) activeRun.current = null;
    }
  };

  const cancelRun = () => {
    const current = activeRun.current;
    if (current) {
      current.controller.abort();
      if (current.source === "local") {
        localRunner().cancel();
      } else {
        api.cancelRun(current.id).catch(() => {});
      }
    } else {
      api.cancelRun().catch(() => {});
    }
  };

  const doSubmit = async (answer: string) => {
    const p = puzzleRef.current;
    if (!p || part === null) return;
    setRun((r) => ({ ...r, submitting: true }));
    try {
      const { outcome, problem: refreshed, committed } = await api.submit(p, part, answer);
      setRun((r) => ({ ...r, submitting: false, submitted: outcome, confirmSubmit: false }));
      if (refreshed) {
        setProblem(refreshed);
        updateMeta(withSuggestions(metaRef.current, refreshed));
        void findSamples(p, refreshed);
      }
      if (committed) notify(committed.succeeded ? "info" : "error", committed.summary);
    } catch (e) {
      setRun((r) => ({ ...r, submitting: false, confirmSubmit: false, error: errorMessage(e) }));
    }
  };

  return { run, setRun, doRun, cancelRun, doSubmit };
}
