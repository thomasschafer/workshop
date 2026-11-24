import { api, isTransientNetworkError, type OfflineDay } from "../api";
import { errorMessage } from "../errors";
import {
  type CachedAocPuzzle,
  deleteAocYear,
  getAocPuzzle,
  getHelpers,
  mergeAocPuzzle,
  putHelpers,
} from "./db";

/** Snapshot of an in-progress or recently stopped incremental year download. */
export interface YearSyncJob {
  year: number;
  /** Days queued for this download batch (already-cached days are skipped). */
  targetDays: readonly number[];
  /** Number of days from `targetDays` saved to IndexedDB so far. */
  completed: number;
  /** Total days in `targetDays`. */
  total: number;
  /** Day currently being fetched from the server, or null when idle. */
  currentDay: number | null;
  /** True while actively fetching days in the background. */
  active: boolean;
  /** True if the user paused the download before finishing all `targetDays`. */
  paused: boolean;
  /** Error message if stopped early; any already-completed days stay cached on the device. */
  error: string | null;
}

export interface YearSyncDeps {
  getPuzzle: (year: number, day: number) => Promise<CachedAocPuzzle | null>;
  mergePuzzle: typeof mergeAocPuzzle;
  deleteYear: (year: number) => Promise<void>;
  fetchDay: (year: number, day: number, signal?: AbortSignal) => Promise<OfflineDay>;
  ensureHelpers: () => Promise<void>;
}

function isFullyCached(puzzle: CachedAocPuzzle | null): boolean {
  return Boolean(puzzle?.problem && puzzle.input !== undefined);
}

async function storeOfflineDay(
  data: OfflineDay,
  deps: Pick<YearSyncDeps, "getPuzzle" | "mergePuzzle">,
): Promise<void> {
  const p = data.puzzle;
  const existing = await deps.getPuzzle(data.year, p.day);
  const patch: Parameters<typeof mergeAocPuzzle>[2] = {
    fileUri: p.file_uri,
    meta: p.meta,
  };
  if (p.problem !== null) patch.problem = p.problem;
  if (p.input !== null) patch.input = p.input;
  if (p.code !== null) {
    patch.code = p.code;
  } else if (!existing?.code) {
    patch.code = { text: data.template, version: data.empty_version, path: "" };
  }
  if (p.notes !== null) {
    patch.notes = p.notes;
  } else if (!existing?.notes) {
    patch.notes = { text: "", version: data.empty_version, path: "" };
  }
  await deps.mergePuzzle(data.year, p.day, patch);
}

const defaultDeps: YearSyncDeps = {
  getPuzzle: getAocPuzzle,
  mergePuzzle: mergeAocPuzzle,
  deleteYear: deleteAocYear,
  fetchDay: (year, day, signal) => api.offlineDay(year, day, signal),
  ensureHelpers: async () => {
    const h = await api.helpers().catch(() => null);
    if (!h) return;
    const existing = await getHelpers(h.language_id);
    if (!existing || existing.text !== h.text) {
      await putHelpers(h.language_id, h.file, h.text);
    }
  },
};

/**
 * Background, incremental, resumable downloader for Advent of Code years. Lives outside UI
 * components so navigating away from the picker never cancels or drops progress, and every day
 * is persisted to IndexedDB the moment it arrives.
 */
export class YearSyncManager {
  private readonly jobs = new Map<number, YearSyncJob>();
  private readonly listeners = new Set<() => void>();
  private activeController: AbortController | null = null;
  private activeYear: number | null = null;
  private runId = 0;

  constructor(private readonly deps: YearSyncDeps = defaultDeps) {}

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(): void {
    for (const listener of this.listeners) listener();
  }

  get(year: number): YearSyncJob | null {
    return this.jobs.get(year) ?? null;
  }

  active(): YearSyncJob | null {
    if (this.activeYear === null) return null;
    const job = this.jobs.get(this.activeYear) ?? null;
    return job?.active ? job : null;
  }

  /** Pauses the currently active download (if matching `year`, or any year if omitted). */
  pause(year?: number): void {
    if (this.activeYear === null) return;
    if (year !== undefined && this.activeYear !== year) return;
    const targetYear = this.activeYear;
    this.activeController?.abort();
    this.activeController = null;
    this.activeYear = null;
    const prev = this.jobs.get(targetYear);
    if (prev?.active) {
      this.jobs.set(targetYear, {
        ...prev,
        active: false,
        paused: true,
        currentDay: null,
        error: null,
      });
    }
    this.notify();
  }

  /** Clears a year's cached puzzles from this device, pausing an active download for it first. */
  async removeYear(year: number): Promise<void> {
    this.pause(year);
    await this.deps.deleteYear(year);
    this.jobs.delete(year);
    this.notify();
  }

  /**
   * Starts (or resumes) saving `candidateDays` one day at a time. Days already cached with both
   * problem and input on this device are skipped automatically.
   */
  async start(year: number, candidateDays: readonly number[]): Promise<void> {
    if (this.activeYear === year && this.jobs.get(year)?.active) return;
    // Pause any other year's download so only one AoC throttle stream runs at once.
    if (this.activeYear !== null && this.activeYear !== year) {
      this.pause(this.activeYear);
    }

    const myRunId = ++this.runId;
    const controller = new AbortController();
    this.activeController = controller;
    this.activeYear = year;

    const missing: number[] = [];
    for (const day of candidateDays) {
      if (controller.signal.aborted || this.runId !== myRunId) return;
      const existing = await this.deps.getPuzzle(year, day);
      if (!isFullyCached(existing)) missing.push(day);
    }
    if (controller.signal.aborted || this.runId !== myRunId) return;

    if (missing.length === 0) {
      this.activeController = null;
      this.activeYear = null;
      this.jobs.set(year, {
        year,
        targetDays: [],
        completed: 0,
        total: 0,
        currentDay: null,
        active: false,
        paused: false,
        error: null,
      });
      this.notify();
      return;
    }

    let completed = 0;
    const setJob = (patch: Partial<YearSyncJob>) => {
      this.jobs.set(year, {
        year,
        targetDays: missing,
        completed,
        total: missing.length,
        currentDay: null,
        active: true,
        paused: false,
        error: null,
        ...patch,
      });
      this.notify();
    };

    setJob({ currentDay: missing[0] ?? null });
    void this.deps.ensureHelpers().catch(() => {});

    for (const day of missing) {
      if (controller.signal.aborted || this.runId !== myRunId) return;
      setJob({ currentDay: day });
      try {
        const data = await this.deps.fetchDay(year, day, controller.signal);
        if (controller.signal.aborted || this.runId !== myRunId) return;
        await storeOfflineDay(data, this.deps);
        completed++;
        setJob({ currentDay: day });
      } catch (e) {
        if (controller.signal.aborted || this.runId !== myRunId) return;
        this.activeController = null;
        this.activeYear = null;
        const message = isTransientNetworkError(e)
          ? completed > 0
            ? `Saved ${completed} of ${missing.length} days before losing connection — resume anytime from day ${day}.`
            : "Couldn't reach the server — try again when connected."
          : completed > 0
            ? `Saved ${completed} of ${missing.length} days before stopping on day ${day}: ${errorMessage(e)}`
            : errorMessage(e);
        setJob({ active: false, paused: false, currentDay: null, error: message });
        return;
      }
    }

    if (this.runId !== myRunId) return;
    this.activeController = null;
    this.activeYear = null;
    setJob({ active: false, paused: false, currentDay: null, error: null });
  }
}

let singleton: YearSyncManager | null = null;

export function yearSync(): YearSyncManager {
  if (!singleton) singleton = new YearSyncManager();
  return singleton;
}
