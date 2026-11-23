// Pluggable on-device code runner and routing policy (`Server` / `Automatic` / `On device`).
//
// Owns a dedicated Runner Web Worker (separate from any future LSP Worker) so cancellation and
// timeouts terminate and respawn the Worker cleanly without disturbing editor diagnostics.

import type { RunResult } from "../api";
import type { Case, CaseRef, CaseResult, Graded, OracleCase, Run } from "../coding/types";
import { sameOutput } from "../learning/output";
import type { OnDeviceMode } from "../preferences";
import { answerWarnings, parseAnswers } from "./answers";
import {
  type BundleSpec,
  bundleForLanguage,
  isBundleCachedOnDevice,
  isLanguageCachedSync,
} from "./bundles";
import type {
  WorkerBootResponse,
  WorkerCommand,
  WorkerHelperFile,
  WorkerReply,
  WorkerRunRequest,
  WorkerRunResponse,
} from "./ghcWorker";

/** Scaled local timeout for Advent of Code runs (GHC WASM is ~30× native CPU on Android). */
export const LOCAL_AOC_TIMEOUT_MS = 45_000;

/** Scaled local per-case timeout for Coding track runs/submissions. */
export const LOCAL_CODING_CASE_TIMEOUT_MS = 15_000;

/** Boot timeout for extracting rootfs and initializing GHC WASM in a fresh Worker. */
export const LOCAL_BOOT_TIMEOUT_MS = 30_000;

export type RunBackend = "server" | "local";

/**
 * Decides up front whether a run uses the server or the on-device runner. Never switches
 * mid-request after a server call may already have started.
 */
export function resolveRunBackend(
  mode: OnDeviceMode,
  online: boolean,
  hasLocalBundle: boolean,
): RunBackend {
  if (mode === "server") return "server";
  if (mode === "local") return hasLocalBundle ? "local" : "server";
  // Automatic: prefer server when reachable, fall back to local when offline and installed.
  if (!online && hasLocalBundle) return "local";
  return "server";
}

export interface LocalAocRequest {
  languageId: string;
  code: string;
  stdin: string;
  helpers?: WorkerHelperFile[] | undefined;
  timeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface LocalCodingRunRequest {
  languageId: string;
  code: string;
  cases: { ref: CaseRef; known: Case }[];
  stopOnFailure: boolean;
  totalCases: number;
  perCaseTimeoutMs?: number | undefined;
  signal?: AbortSignal | undefined;
}

export interface LocalCodingSubmitOutcome {
  /** True when a case hit the local timeout: inconclusive, do not fail or record `too-slow`. */
  inconclusive: boolean;
  inconclusiveMessage?: string | undefined;
  graded: Graded;
}

export interface LocalRunner {
  readonly engineName: string;
  isAvailable(languageId: string): Promise<boolean>;
  isAvailableSync(languageId: string): boolean;
  runAoc(request: LocalAocRequest): Promise<{ result: RunResult; engine: string }>;
  runCoding(
    request: LocalCodingRunRequest,
  ): Promise<{ graded: Graded; timedOut: boolean; engine: string }>;
  cancel(): void;
  dispose(): void;
}

export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  addEventListener(type: "message", listener: (ev: MessageEvent<WorkerReply>) => void): void;
  addEventListener(type: "error", listener: (ev: ErrorEvent) => void): void;
  removeEventListener(type: "message", listener: (ev: MessageEvent<WorkerReply>) => void): void;
  removeEventListener(type: "error", listener: (ev: ErrorEvent) => void): void;
}

export type WorkerFactory = () => WorkerLike;

function defaultWorkerFactory(): WorkerLike {
  return new Worker(new URL("./ghcWorker.ts", import.meta.url), { type: "module" });
}

class RunCancelledError extends Error {
  constructor() {
    super("Run cancelled.");
    this.name = "RunCancelledError";
  }
}

class RunTimedOutError extends Error {
  constructor(readonly limitMs: number) {
    super(`Timed out after ${(limitMs / 1000).toFixed(0)}s on this device.`);
    this.name = "RunTimedOutError";
  }
}

/**
 * GHC 9.14 WASM runner hosted in a dedicated Web Worker.
 * Terminates and respawns the Worker cleanly on Cancel or timeout so infinite loops stop at once.
 */
export class GhcWasmLocalRunner implements LocalRunner {
  readonly engineName = "GHC 9.14 WASM";
  private worker: WorkerLike | null = null;
  private bootedKey: string | null = null;
  private nextId = 1;
  private activeAbort: (() => void) | null = null;
  private readonly createWorker: WorkerFactory;

  constructor(createWorker: WorkerFactory = defaultWorkerFactory) {
    this.createWorker = createWorker;
  }

  async isAvailable(languageId: string): Promise<boolean> {
    const bundle = bundleForLanguage(languageId);
    if (!bundle) return false;
    return isBundleCachedOnDevice(bundle);
  }

  isAvailableSync(languageId: string): boolean {
    return isLanguageCachedSync(languageId);
  }

  cancel(): void {
    this.activeAbort?.();
  }

  dispose(): void {
    this.activeAbort?.();
    this.terminateWorker();
  }

  private terminateWorker(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.bootedKey = null;
  }

  private async ensureBooted(bundle: BundleSpec, signal?: AbortSignal): Promise<void> {
    const key = `${bundle.id}@${bundle.version}`;
    if (this.worker && this.bootedKey === key) return;
    this.terminateWorker();
    this.worker = this.createWorker();
    try {
      await this.callWorker<WorkerBootResponse>(
        { id: this.nextId++, cmd: "boot", bundle },
        LOCAL_BOOT_TIMEOUT_MS,
        signal,
      );
      this.bootedKey = key;
    } catch (err) {
      this.terminateWorker();
      throw err;
    }
  }

  private callWorker<T extends WorkerBootResponse | WorkerRunResponse>(
    cmd: WorkerCommand,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const worker = this.worker;
    if (!worker) return Promise.reject(new Error("Worker is not running."));
    if (signal?.aborted) return Promise.reject(new RunCancelledError());

    return new Promise<T>((resolve, reject) => {
      let settled = false;

      const cleanup = () => {
        clearTimeout(timer);
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        signal?.removeEventListener("abort", onCancel);
        if (this.activeAbort === onCancel) this.activeAbort = null;
      };

      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        cleanup();
        fn();
      };

      const onMessage = (ev: MessageEvent<WorkerReply>) => {
        const reply = ev.data;
        if (reply.id !== cmd.id) return;
        if (reply.ok) {
          finish(() => resolve(reply.result as T));
        } else {
          finish(() => reject(new Error(reply.error)));
        }
      };

      const onError = (ev: ErrorEvent) => {
        this.terminateWorker();
        finish(() => reject(new Error(ev.message || "On-device GHC WASM worker crashed.")));
      };

      const onCancel = () => {
        this.terminateWorker();
        finish(() => reject(new RunCancelledError()));
      };

      const timer = setTimeout(() => {
        this.terminateWorker();
        finish(() => reject(new RunTimedOutError(timeoutMs)));
      }, timeoutMs);

      this.activeAbort = onCancel;
      signal?.addEventListener("abort", onCancel, { once: true });
      worker.addEventListener("message", onMessage);
      worker.addEventListener("error", onError);
      worker.postMessage(cmd);
    });
  }

  private async execOnce(
    bundle: BundleSpec,
    payload: WorkerRunRequest,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<WorkerRunResponse> {
    await this.ensureBooted(bundle, signal);
    return this.callWorker<WorkerRunResponse>(
      { id: this.nextId++, cmd: "run", payload },
      timeoutMs,
      signal,
    );
  }

  async runAoc(request: LocalAocRequest): Promise<{ result: RunResult; engine: string }> {
    const bundle = bundleForLanguage(request.languageId);
    if (!bundle) {
      throw new Error(`No on-device runner is available for ${request.languageId}.`);
    }
    const timeoutMs = request.timeoutMs ?? LOCAL_AOC_TIMEOUT_MS;
    const t0 = performance.now();
    try {
      const reply = await this.execOnce(
        bundle,
        { code: request.code, stdin: request.stdin, helpers: request.helpers },
        timeoutMs,
        request.signal,
      );
      const answers = reply.phase === "run" ? parseAnswers(reply.stdout) : [];
      const warnings = answerWarnings(answers);
      return {
        engine: bundle.engine,
        result: {
          phase: reply.phase,
          ending: { status: "exited", code: reply.exitCode },
          stdout: reply.stdout,
          stderr: reply.stderr,
          duration_ms: reply.durationMs,
          answers,
          warnings,
        },
      };
    } catch (err) {
      if (err instanceof RunTimedOutError) {
        return {
          engine: bundle.engine,
          result: {
            phase: "run",
            ending: { status: "timed_out" },
            stdout: "",
            stderr: `Stopped after ${(err.limitMs / 1000).toFixed(0)}s on this device. For heavy inputs, switch to Server or run on your desktop.`,
            duration_ms: Math.round(performance.now() - t0),
            answers: [],
            warnings: [],
          },
        };
      }
      if (err instanceof RunCancelledError) {
        return {
          engine: bundle.engine,
          result: {
            phase: "run",
            ending: { status: "cancelled" },
            stdout: "",
            stderr: "",
            duration_ms: Math.round(performance.now() - t0),
            answers: [],
            warnings: [],
          },
        };
      }
      throw err;
    }
  }

  async runCoding(
    request: LocalCodingRunRequest,
  ): Promise<{ graded: Graded; timedOut: boolean; engine: string }> {
    const bundle = bundleForLanguage(request.languageId);
    if (!bundle) {
      return {
        engine: this.engineName,
        timedOut: false,
        graded: {
          outcome: "unavailable",
          reason: `No on-device runner is available for ${request.languageId}.`,
        },
      };
    }

    const perCaseTimeout = request.perCaseTimeoutMs ?? LOCAL_CODING_CASE_TIMEOUT_MS;
    const results: CaseResult[] = [];

    for (const item of request.cases) {
      try {
        const reply = await this.execOnce(
          bundle,
          { code: request.code, stdin: item.known.input },
          perCaseTimeout,
          request.signal,
        );
        if (reply.phase === "build") {
          return {
            engine: bundle.engine,
            timedOut: false,
            graded: { outcome: "build_failed", errors: reply.stderr },
          };
        }
        const run: Run = {
          ending: { status: "exited", code: reply.exitCode },
          stdout: reply.stdout,
          stderr: reply.stderr,
          cut_off: null,
          duration_ms: reply.durationMs,
        };
        const passed = reply.exitCode === 0 && sameOutput(item.known.output, reply.stdout);
        results.push({
          case: item.ref,
          input: item.known.input,
          expected: item.known.output,
          run,
          passed,
        });
        if (!passed && request.stopOnFailure) {
          break;
        }
      } catch (err) {
        if (err instanceof RunTimedOutError) {
          const run: Run = {
            ending: { status: "timed_out" },
            stdout: "",
            stderr: err.message,
            cut_off: null,
            duration_ms: perCaseTimeout,
          };
          results.push({
            case: item.ref,
            input: item.known.input,
            expected: item.known.output,
            run,
            passed: false,
          });
          return {
            engine: bundle.engine,
            timedOut: true,
            graded: { outcome: "ran", results, total: request.totalCases },
          };
        }
        throw err;
      }
    }

    return {
      engine: bundle.engine,
      timedOut: false,
      graded: { outcome: "ran", results, total: request.totalCases },
    };
  }
}

/** Builds the ordered Coding submission case list: examples -> precomputed oracles -> hidden tests. */
export function buildCodingSubmitCases(
  parts: readonly { examples: Case[] }[],
  hiddenTests: readonly Case[][],
  oracleCases: readonly OracleCase[],
  currentPart: number,
): { ref: CaseRef; known: Case }[] {
  const inParts = parts.length > 1;
  const cases: { ref: CaseRef; known: Case }[] = [];

  for (let p = 0; p <= currentPart && p < parts.length; p++) {
    const part = parts[p];
    if (!part) continue;
    for (let i = 0; i < part.examples.length; i++) {
      const known = part.examples[i];
      if (!known) continue;
      cases.push({
        ref: inParts ? { kind: "example", part: p, index: i } : { kind: "example", index: i },
        known,
      });
    }
  }

  for (const oracle of oracleCases) {
    cases.push({
      ref: inParts
        ? { kind: "random", part: currentPart, seed: oracle.seed, size: oracle.size }
        : { kind: "random", seed: oracle.seed, size: oracle.size },
      known: { input: oracle.input, output: oracle.output },
    });
  }

  for (let p = 0; p <= currentPart && p < hiddenTests.length; p++) {
    const tests = hiddenTests[p] ?? [];
    for (let i = 0; i < tests.length; i++) {
      const known = tests[i];
      if (!known) continue;
      cases.push({
        ref: inParts ? { kind: "test", part: p, index: i } : { kind: "test", index: i },
        known,
      });
    }
  }

  return cases;
}

/** Builds the Coding examples case list for the current part (matching `crates/coding/src/grade.rs`). */
export function buildCodingExampleCases(
  parts: readonly { examples: Case[] }[],
  currentPart: number,
): { ref: CaseRef; known: Case }[] {
  const inParts = parts.length > 1;
  const cases: { ref: CaseRef; known: Case }[] = [];
  for (let p = 0; p <= currentPart && p < parts.length; p++) {
    const part = parts[p];
    if (!part) continue;
    for (let i = 0; i < part.examples.length; i++) {
      const known = part.examples[i];
      if (!known) continue;
      cases.push({
        ref: inParts ? { kind: "example", part: p, index: i } : { kind: "example", index: i },
        known,
      });
    }
  }
  return cases;
}

let sharedRunner: GhcWasmLocalRunner | null = null;

export function localRunner(): GhcWasmLocalRunner {
  if (!sharedRunner) {
    sharedRunner = new GhcWasmLocalRunner();
  }
  return sharedRunner;
}
