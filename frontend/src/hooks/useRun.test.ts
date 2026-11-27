import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DayMeta, Problem, Puzzle, RunResult, SubmitOutcome } from "../api";
import type { CodeEditor } from "../editor";
import type { LatestSaver, VersionedSaver } from "../saver";
import type { RunState } from "../views/run";

interface HookSlot {
  value: unknown;
}

const hookState = {
  slots: [] as HookSlot[],
  cursor: 0,
  rerender: () => {},
};

function slotAt(index: number): HookSlot {
  const slot = hookState.slots[index];
  if (!slot) throw new Error(`missing hook slot ${index}`);
  return slot;
}

vi.mock("preact/hooks", () => ({
  useState<T>(initial: T | (() => T)) {
    const index = hookState.cursor++;
    if (index >= hookState.slots.length) {
      const value = typeof initial === "function" ? (initial as () => T)() : initial;
      hookState.slots.push({ value });
    }
    const set = (next: T | ((prev: T) => T)) => {
      const slot = slotAt(index);
      const prev = slot.value as T;
      const value = typeof next === "function" ? (next as (p: T) => T)(prev) : next;
      if (!Object.is(prev, value)) {
        slot.value = value;
        hookState.rerender();
      }
    };
    return [slotAt(index).value as T, set] as const;
  },
  useRef<T>(initial: T) {
    const index = hookState.cursor++;
    if (index >= hookState.slots.length) {
      hookState.slots.push({ value: { current: initial } });
    }
    return slotAt(index).value as { current: T };
  },
  useCallback<T>(fn: T) {
    return fn;
  },
  useEffect() {},
}));

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  cancelRun: vi.fn(async (_id?: string) => {}),
  submit: vi.fn(),
  isAvailable: vi.fn(async () => false),
  runAoc: vi.fn(),
  cancelLocal: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: {
      ...actual.api,
      run: mocks.run,
      cancelRun: mocks.cancelRun,
      submit: mocks.submit,
    },
  };
});

vi.mock("../onDevice/runner", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../onDevice/runner")>();
  return {
    ...actual,
    localRunner: () => ({
      isAvailable: mocks.isAvailable,
      runAoc: mocks.runAoc,
      cancel: mocks.cancelLocal,
    }),
  };
});

import { useRun } from "./useRun";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function fakeResult(stdout: string): RunResult {
  return {
    phase: "run",
    ending: { status: "exited", code: 0 },
    stdout,
    stderr: "",
    answers: [stdout.trim()],
    warnings: [],
    duration_ms: 5,
  };
}

function emptyMeta(): DayMeta {
  return {
    sample_blocks: [null, null],
    sample_inputs: [null, null],
    sample_answers: [null, null],
    cursor: 0,
    version: 0,
  };
}

function mountUseRun(initialPuzzle: Puzzle) {
  hookState.slots = [];
  const puzzleRef = { current: initialPuzzle as Puzzle | null };
  const metaRef = { current: emptyMeta() };
  const metaSavers = { current: new Map<string, LatestSaver<DayMeta>>() };
  const saver = { current: null as VersionedSaver | null };
  const editor = { current: { text: () => "print(1)" } as unknown as CodeEditor };
  const setSheet = vi.fn();
  const setProblem = vi.fn();
  const updateMeta = vi.fn();
  const findSamples = vi.fn(async () => {});
  const notify = vi.fn();
  const formatBeforeRun = vi.fn(async () => {});

  let latest!: ReturnType<typeof useRun>;
  let mode: "server" | "local" = "server";
  const render = () => {
    hookState.cursor = 0;
    latest = useRun({
      puzzleRef,
      part: 1,
      workingPart: 1,
      languageId: "python",
      onDeviceMode: mode,
      online: true,
      editor,
      metaRef,
      metaSavers,
      saver,
      queue: { idle: async () => {} },
      setSheet,
      setProblem,
      updateMeta,
      findSamples,
      notify,
      formatBeforeRun,
    });
  };
  hookState.rerender = render;
  render();

  return {
    get state(): RunState {
      return latest.run;
    },
    get current() {
      return latest;
    },
    setMode(next: "server" | "local") {
      mode = next;
      render();
    },
    puzzleRef,
    setProblem,
    updateMeta,
    findSamples,
    notify,
  };
}

describe("useRun concurrency and puzzle switches", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.isAvailable.mockResolvedValue(false);
    mocks.cancelRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps running state and cancels the superseded server run on overlapping runs", async () => {
    const run1 = deferred<RunResult>();
    const run2 = deferred<RunResult>();
    const signals: AbortSignal[] = [];
    const ids: string[] = [];
    mocks.run
      .mockImplementationOnce((_p, _i, _part, id: string, signal: AbortSignal) => {
        ids.push(id);
        signals.push(signal);
        return run1.promise;
      })
      .mockImplementationOnce((_p, _i, _part, id: string, signal: AbortSignal) => {
        ids.push(id);
        signals.push(signal);
        return run2.promise;
      });

    const h = mountUseRun({ year: 2024, day: 1 });
    const p1 = h.current.doRun("real", false);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(h.state.running).toBe("real");

    // Start a second run while run 1 is still in flight.
    const p2 = h.current.doRun("real", false);
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(signals[0]?.aborted).toBe(true);
    run1.reject(new DOMException("aborted", "AbortError"));
    await p1;

    // Run 1's abort must not clear Run 2's running state or fail to cancel Run 1 on the server.
    expect(h.state.running).toBe("real");
    expect(mocks.cancelRun).toHaveBeenCalledWith(ids[0]);

    run2.resolve(fakeResult("99\n"));
    await p2;
    expect(h.state.running).toBeNull();
    expect(h.state.last?.result.stdout).toBe("99\n");
  });

  it("ignores in-flight run and submit responses after switching to another puzzle", async () => {
    const run1 = deferred<RunResult>();
    mocks.run.mockReturnValueOnce(run1.promise);
    const submit1 = deferred<{
      outcome: SubmitOutcome;
      problem: Problem | null;
      committed: null;
    }>();
    mocks.submit.mockReturnValueOnce(submit1.promise);

    const h = mountUseRun({ year: 2024, day: 1 });
    const pRun = h.current.doRun("real", false);
    for (let i = 0; i < 8; i++) await Promise.resolve();

    const pSubmit = h.current.doSubmit("42");

    // Switch to another puzzle while both run and submit are in flight.
    h.puzzleRef.current = { year: 2024, day: 2 };
    h.current.abortRun();
    h.current.setRun({
      running: null,
      submitting: false,
      last: null,
      submitted: null,
      confirmSubmit: false,
      error: null,
    });

    run1.resolve(fakeResult("puzzle-1-output\n"));
    await pRun;
    expect(h.state.last).toBeNull();

    submit1.resolve({
      outcome: { result: "correct" },
      problem: {
        title: "Day 1",
        parts_html: ["<p>Day 1</p>"],
        text: "Day 1",
        answers: ["42"],
        stars: 1,
        final_star: null,
        suggested_sample_answers: [null, null],
        suggested_sample_blocks: [null, null],
        blocks: [],
      },
      committed: null,
    });
    await pSubmit;
    expect(h.state.submitted).toBeNull();
    expect(h.setProblem).not.toHaveBeenCalled();
    expect(h.updateMeta).not.toHaveBeenCalled();
    expect(h.findSamples).not.toHaveBeenCalled();
  });
});
