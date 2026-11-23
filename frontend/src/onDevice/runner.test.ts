import { describe, expect, it } from "vitest";
import type { WorkerCommand, WorkerReply } from "./ghcWorker";
import { classifyGhcOutput } from "./ghcWorker";
import {
  buildCodingSubmitCases,
  GhcWasmLocalRunner,
  resolveRunBackend,
  type WorkerLike,
} from "./runner";

class FakeWorker implements WorkerLike {
  terminated = false;
  private readonly msgListeners = new Set<(ev: MessageEvent<WorkerReply>) => void>();
  private readonly errListeners = new Set<(ev: ErrorEvent) => void>();

  constructor(
    private readonly handler: (cmd: WorkerCommand, emit: (r: WorkerReply) => void) => void,
  ) {}

  postMessage(message: unknown): void {
    const cmd = message as WorkerCommand;
    queueMicrotask(() => {
      if (this.terminated) return;
      this.handler(cmd, (reply) => {
        if (this.terminated) return;
        for (const l of this.msgListeners) {
          l({ data: reply } as MessageEvent<WorkerReply>);
        }
      });
    });
  }

  terminate(): void {
    this.terminated = true;
  }

  addEventListener(type: "message" | "error", listener: unknown): void {
    if (type === "message") {
      this.msgListeners.add(listener as (ev: MessageEvent<WorkerReply>) => void);
    } else {
      this.errListeners.add(listener as (ev: ErrorEvent) => void);
    }
  }

  removeEventListener(type: "message" | "error", listener: unknown): void {
    if (type === "message") {
      this.msgListeners.delete(listener as (ev: MessageEvent<WorkerReply>) => void);
    } else {
      this.errListeners.delete(listener as (ev: ErrorEvent) => void);
    }
  }
}

describe("resolveRunBackend", () => {
  it("respects Server / Automatic / On device routing up front", () => {
    expect(resolveRunBackend("server", true, true)).toBe("server");
    expect(resolveRunBackend("server", false, true)).toBe("server");
    expect(resolveRunBackend("automatic", true, true)).toBe("server");
    expect(resolveRunBackend("automatic", false, true)).toBe("local");
    expect(resolveRunBackend("automatic", false, false)).toBe("server");
    expect(resolveRunBackend("local", true, true)).toBe("local");
    expect(resolveRunBackend("local", true, false)).toBe("server");
    expect(resolveRunBackend("local", false, true)).toBe("local");
  });
});

describe("classifyGhcOutput", () => {
  it("classifies build failures and explains missing unbundled packages", () => {
    const res = classifyGhcOutput(
      "/tmp/Main.hs:1:1: error:\n    Could not find module ‘Data.List.Split’\n\nuser error (load returned Failed)\n",
      "ExitFailure 1",
      ["base", "containers"],
    );
    expect(res.phase).toBe("build");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).not.toContain("load returned Failed");
    expect(res.stderr).toContain("package 'split'");
  });

  it("strips the playground panic wrapper around runtime exceptions", () => {
    const res = classifyGhcOutput(
      "panic! (the 'impossible' happened)\n  GHC version 9.14.0.20251031:\n\tboom\n\nHasCallStack backtrace:\n  error, called at /tmp/Main.hs:2:8\n\n\nPlease report this as a GHC bug:  https://www.haskell.org/ghc/reportabug\n",
      "ExitFailure 1",
      ["base"],
    );
    expect(res.phase).toBe("run");
    expect(res.exitCode).toBe(1);
    expect(res.stderr).toContain("boom");
    expect(res.stderr).not.toContain("Please report this as a GHC bug");
  });
});

describe("GhcWasmLocalRunner", () => {
  it("runs AoC code, parses answers & decimal warnings, and terminates on timeout", async () => {
    const workers: FakeWorker[] = [];
    const runner = new GhcWasmLocalRunner(() => {
      const w = new FakeWorker((cmd, emit) => {
        if (cmd.cmd === "boot") {
          emit({ id: cmd.id, ok: true, result: { bootMs: 10, wasmMemoryBytes: 1024 } });
          return;
        }
        if (cmd.payload.code.includes("loop")) {
          // Never replies — simulates an infinite loop.
          return;
        }
        emit({
          id: cmd.id,
          ok: true,
          result: {
            phase: "run",
            exitCode: 0,
            stdout: '"abc"\n3.0\n',
            stderr: "",
            durationMs: 42,
          },
        });
      });
      workers.push(w);
      return w;
    });

    const first = await runner.runAoc({
      languageId: "haskell",
      code: 'main = putStrLn "abc"',
      stdin: "1\n2\n",
    });
    expect(first.result.phase).toBe("run");
    expect(first.result.answers).toEqual(["abc", "3.0"]);
    expect(first.result.warnings).toHaveLength(1);
    expect(workers).toHaveLength(1);

    const timedOut = await runner.runAoc({
      languageId: "haskell",
      code: "loop",
      stdin: "",
      timeoutMs: 25,
    });
    expect(timedOut.result.ending.status).toBe("timed_out");
    expect(workers[0]?.terminated).toBe(true);

    // Respawns a clean worker on the next run.
    const recovered = await runner.runAoc({
      languageId: "haskell",
      code: "main = print 1",
      stdin: "",
    });
    expect(recovered.result.ending).toEqual({ status: "exited", code: 0 });
    expect(workers).toHaveLength(2);
  });

  it("grades Coding cases in order (examples -> oracles -> hidden) and flags timeouts as inconclusive", async () => {
    const runner = new GhcWasmLocalRunner(() => {
      return new FakeWorker((cmd, emit) => {
        if (cmd.cmd === "boot") {
          emit({ id: cmd.id, ok: true, result: { bootMs: 5, wasmMemoryBytes: 512 } });
          return;
        }
        if (cmd.payload.stdin === "slow") return;
        emit({
          id: cmd.id,
          ok: true,
          result: {
            phase: "run",
            exitCode: 0,
            stdout: `${cmd.payload.stdin.trim()}!\n`,
            stderr: "",
            durationMs: 5,
          },
        });
      });
    });

    const cases = buildCodingSubmitCases(
      [{ examples: [{ input: "a\n", output: "a!\n" }] }],
      [[{ input: "slow", output: "slow!\n" }]],
      [{ seed: 1, size: 4, input: "b\n", output: "b!\n" }],
      0,
    );
    expect(cases.map((c) => c.ref.kind)).toEqual(["example", "random", "test"]);

    const outcome = await runner.runCoding({
      languageId: "haskell",
      code: "main = interact id",
      cases,
      stopOnFailure: true,
      totalCases: cases.length,
      perCaseTimeoutMs: 25,
    });
    expect(outcome.timedOut).toBe(true);
    expect(outcome.graded.outcome).toBe("ran");
    if (outcome.graded.outcome === "ran") {
      expect(outcome.graded.results).toHaveLength(3);
      expect(outcome.graded.results[0]?.passed).toBe(true);
      expect(outcome.graded.results[1]?.passed).toBe(true);
      expect(outcome.graded.results[2]?.run.ending.status).toBe("timed_out");
    }
  });
});
