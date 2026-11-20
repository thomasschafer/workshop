import type { RefObject } from "preact";
import { useRef, useState } from "preact/hooks";
import { api, type DayMeta, type Problem, type Puzzle } from "../api";
import { errorMessage } from "../errors";
import { newId } from "../learning/local";
import { sampleInput, withSuggestions } from "../samples";
import type { LatestSaver, VersionedSaver } from "../saver";
import { type InputKind, initialRunState, type RunState } from "../views/run";

interface Options {
  puzzleRef: RefObject<Puzzle | null>;
  /** The next part to solve, or null once both are. */
  part: number | null;
  /** The part being worked on, whose sample is run. */
  workingPart: number;
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
  const activeRun = useRef<{ id: string; controller: AbortController } | null>(null);

  /**
   * Runs the solution. From the Run sheet it first waits for edits still being made from
   * earlier utterances, so it runs what was said; a spoken "run" is already queued after them.
   */
  const doRun = async (input: InputKind, waitForEdits: boolean) => {
    const p = puzzleRef.current;
    if (!p) return;
    setSheet("run");
    const runPart = workingPart;
    if (input === "sample" && sampleInput(metaRef.current, runPart === 1 ? 0 : 1) === null) {
      setRun((r) => ({
        ...r,
        error: "Choose the sample input first: tap a code block in the puzzle.",
      }));
      return;
    }
    setRun((r) => ({ ...r, running: input, error: null, submitted: null, confirmSubmit: false }));
    const runId = newId();
    const controller = new AbortController();
    activeRun.current = { id: runId, controller };
    try {
      if (waitForEdits) await queue.idle();
      await formatBeforeRun();
      try {
        // The run reads the code and the chosen sample from the server.
        await saver.current?.flush();
        await metaSavers.current.get(`${p.year}-${p.day}`)?.flush();
      } catch (e) {
        setRun((r) => ({ ...r, running: null, error: `Not run: ${errorMessage(e)}` }));
        return;
      }
      const result = await api.run(p, input, runPart, runId, controller.signal);
      setRun((r) => ({ ...r, running: null, last: { input, result } }));
    } catch (e) {
      if (controller.signal.aborted) {
        // Best-effort server cancel scoped by runId so run_lock is released without killing a
        // newer run if this cancel arrives late.
        api.cancelRun(runId).catch(() => {});
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
      api.cancelRun(current.id).catch(() => {});
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
