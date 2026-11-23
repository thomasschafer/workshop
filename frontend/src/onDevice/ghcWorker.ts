// Dedicated Web Worker that boots GHC 9.14 WASM from Cache Storage and runs Haskell solutions
// against stdin in isolation from any LSP Worker. Terminated immediately on Cancel or timeout.

import {
  ConsoleStdout,
  Directory,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
} from "../../vendor/ghc-wasm/browser_wasi_shim.mjs";
import {
  DyLDBrowserHost,
  type DyLDInstance,
  main as dyldMain,
} from "../../vendor/ghc-wasm/dyld.mjs";
import { type BundleSpec, readVerifiedBundleFile } from "./bundles";

export interface WorkerHelperFile {
  /** Module filename under `/work/`, e.g. `Aoc.hs`. */
  name: string;
  text: string;
}

export interface WorkerRunRequest {
  code: string;
  stdin: string;
  helpers?: WorkerHelperFile[] | undefined;
  ghcArgs?: string | undefined;
}

export interface WorkerRunResponse {
  phase: "build" | "run";
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

export interface WorkerBootResponse {
  bootMs: number;
  wasmMemoryBytes: number;
}

export type WorkerCommand =
  | { id: number; cmd: "boot"; bundle: BundleSpec }
  | { id: number; cmd: "run"; payload: WorkerRunRequest };

export type WorkerReply =
  | { id: number; ok: true; result: WorkerBootResponse | WorkerRunResponse }
  | { id: number; ok: false; error: string };

const encoder = new TextEncoder();

// Resets GHC's global `stdin` Handle back to an open ReadHandle with fresh buffers after a
// previous run's lazy `getContents` transitioned it to SemiClosedHandle. WASI fd 0 is kept
// permanently open by dyld.mjs and repopulated via `dyld.setStdin(bytes)` before each run.
const RESET_STDIN_MODULE = `module Main where
import Control.Concurrent.MVar (modifyMVar_)
import Data.IORef (newIORef)
import System.IO (stdin)
import GHC.IO.Buffer (newByteBuffer, newCharBuffer, BufferState(ReadBuffer))
import GHC.IO.Handle.Types (Handle(..), Handle__(..), HandleType(..))
main :: IO ()
main = case stdin of
  FileHandle _ mv -> modifyMVar_ mv $ \\h -> do
    bb <- newByteBuffer 8192 ReadBuffer
    cb <- newCharBuffer 2048 ReadBuffer
    bbRef <- newIORef bb
    cbRef <- newIORef cb
    pure h { haType = ReadHandle, haByteBuffer = bbRef, haCharBuffer = cbRef }
  _ -> pure ()
`;

let rootfs: PreopenDirectory | null = null;
let dyld: DyLDInstance | null = null;
let runPlayground: ((ghcArgs: string, code: string) => Promise<void>) | null = null;
let loadedBundle: BundleSpec | null = null;
let stdinDirty = false;
let stdoutChunks: Uint8Array[] = [];
let stderrChunks: Uint8Array[] = [];

function concatText(chunks: Uint8Array[]): string {
  if (chunks.length === 0) return "";
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    merged.set(c, offset);
    offset += c.byteLength;
  }
  return new TextDecoder("utf-8").decode(merged);
}

function syncWorkDir(helpers: WorkerHelperFile[] | undefined): void {
  if (!rootfs) return;
  const work = new Directory([]);
  if (helpers) {
    for (const helper of helpers) {
      if (!helper.name || helper.name.includes("/") || helper.name.includes("..")) continue;
      work.contents.set(helper.name, new File(encoder.encode(helper.text)));
    }
  }
  rootfs.dir.contents.set("work", work);
}

/**
 * Classifies GHCi playground stderr into build vs run failure and cleans up the GHCi playground
 * panic wrapper that wraps ordinary user runtime exceptions (`error`, `undefined`, pattern match).
 */
export function classifyGhcOutput(
  stderrRaw: string,
  threw: string | null,
  bundledPackages: readonly string[],
): { phase: "build" | "run"; exitCode: number; stderr: string } {
  const isBuildFailure = stderrRaw.includes("user error (load returned Failed)");
  let stderr = stderrRaw;

  if (isBuildFailure) {
    stderr = stderr.replace(/\n?user error \(load returned Failed\)\s*$/, "").trimEnd();
    stderr = appendMissingPackageHint(stderr, bundledPackages);
    return { phase: "build", exitCode: 1, stderr };
  }

  if (threw !== null) {
    // Strip the playground's `panic! (the 'impossible' happened)` wrapper around user exceptions.
    const panicMatch = stderr.match(
      /^panic! \(the 'impossible' happened\)\n\s+GHC version [^\n]+:\n\t([\s\S]*?)\n\nPlease report this as a GHC bug:[^\n]*\s*$/,
    );
    if (panicMatch?.[1]) {
      stderr = panicMatch[1].trimEnd();
    } else if (!stderr.trim()) {
      stderr = threw;
    }
    const exitMatch = threw.match(/ExitFailure\s+(-?\d+)/);
    const code = exitMatch?.[1] ? Number.parseInt(exitMatch[1], 10) : 1;
    return { phase: "run", exitCode: Number.isFinite(code) && code !== 0 ? code : 1, stderr };
  }

  return { phase: "run", exitCode: 0, stderr };
}

function appendMissingPackageHint(stderr: string, bundledPackages: readonly string[]): string {
  const missingMatch = stderr.match(/Could not (?:find|load) module [‘'`]([A-Za-z0-9_.]+)[’'`]/);
  if (!missingMatch?.[1]) return stderr;
  const mod = missingMatch[1];
  const knownUnbundled: Record<string, string> = {
    "Data.List.Split": "split",
    "Data.HashMap": "unordered-containers",
    "Data.HashSet": "unordered-containers",
    "Text.Parsec": "parsec",
  };
  const pkg = Object.entries(knownUnbundled).find(
    ([prefix]) => mod === prefix || mod.startsWith(`${prefix}.`),
  )?.[1];
  if (pkg && !bundledPackages.includes(pkg)) {
    return `${stderr}\n\nNote: package '${pkg}' isn't included in this on-device GHC WASM bundle yet (bundled: ${bundledPackages.join(", ")}). Run on the server or rebuild the bundle with scripts/build-ghc-wasm-bundle.sh.`;
  }
  return stderr;
}

async function boot(bundle: BundleSpec): Promise<WorkerBootResponse> {
  if (runPlayground && loadedBundle?.id === bundle.id && loadedBundle.version === bundle.version) {
    return { bootMs: 0, wasmMemoryBytes: dyld?.wasmMemoryBytes ?? 0 };
  }

  const t0 = performance.now();
  const [bsdtarBytes, rootfsBytes] = await Promise.all([
    readVerifiedBundleFile(bundle, "bsdtar.wasm"),
    readVerifiedBundleFile(bundle, "rootfs.tar.zst"),
  ]);

  rootfs = new PreopenDirectory("/", []);
  const bsdtarWasi = new WASI(
    ["bsdtar.wasm", "-x"],
    [],
    [
      new OpenFile(new File(rootfsBytes, { readonly: true })),
      ConsoleStdout.lineBuffered(() => {}),
      ConsoleStdout.lineBuffered(() => {}),
      rootfs,
    ],
    { debug: false },
  );

  const bsdtarCopy = new Uint8Array(bsdtarBytes.byteLength);
  bsdtarCopy.set(bsdtarBytes);
  const { instance } = await WebAssembly.instantiate(bsdtarCopy, {
    wasi_snapshot_preview1: bsdtarWasi.wasiImport,
  });
  bsdtarWasi.start(instance);

  dyld = await dyldMain({
    rpc: new DyLDBrowserHost({
      rootfs,
      stdoutChunk: (buf) => stdoutChunks.push(buf.slice()),
      stderrChunk: (buf) => stderrChunks.push(buf.slice()),
    }),
    searchDirs: ["/tmp/clib", bundle.ghc_lib_search_dir],
    mainSoPath: bundle.main_so_path,
    args: ["libplayground001.so", "+RTS", "-c", "-RTS"],
    isIserv: false,
  });

  runPlayground = await dyld.exportFuncs.myMain(bundle.ghc_libdir);
  loadedBundle = bundle;
  stdinDirty = false;

  return {
    bootMs: Math.round(performance.now() - t0),
    wasmMemoryBytes: dyld.wasmMemoryBytes,
  };
}

async function run(req: WorkerRunRequest): Promise<WorkerRunResponse> {
  if (!runPlayground || !dyld || !loadedBundle) {
    throw new Error("On-device GHC WASM worker isn't booted.");
  }

  syncWorkDir(req.helpers);
  dyld.setStdin(encoder.encode(req.stdin));

  if (stdinDirty) {
    stdoutChunks = [];
    stderrChunks = [];
    await runPlayground("-v0", RESET_STDIN_MODULE);
  }

  stdoutChunks = [];
  stderrChunks = [];
  const ghcArgs = ["-v0", "-i/work", req.ghcArgs ?? ""].filter(Boolean).join(" ");

  const t0 = performance.now();
  let threw: string | null = null;
  try {
    await runPlayground(ghcArgs, req.code);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  } finally {
    stdinDirty = true;
  }

  const durationMs = Math.max(0, Math.round(performance.now() - t0));
  const stdout = concatText(stdoutChunks);
  const stderrRaw = concatText(stderrChunks);
  const classified = classifyGhcOutput(stderrRaw, threw, loadedBundle.packages);

  return {
    phase: classified.phase,
    exitCode: classified.exitCode,
    stdout,
    stderr: classified.stderr,
    durationMs,
  };
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  let activeId: number | null = null;

  const failActive = (err: unknown) => {
    if (activeId === null) return;
    const id = activeId;
    activeId = null;
    const error = err instanceof Error ? err.message : String(err);
    const reply: WorkerReply = { id, ok: false, error };
    self.postMessage(reply);
  };

  self.addEventListener("error", (ev) => {
    failActive(ev.error ?? ev.message);
  });

  self.addEventListener("unhandledrejection", (ev) => {
    failActive(ev.reason);
  });

  self.addEventListener("message", async (ev: MessageEvent<WorkerCommand>) => {
    const msg = ev.data;
    activeId = msg.id;
    try {
      const result = msg.cmd === "boot" ? await boot(msg.bundle) : await run(msg.payload);
      if (activeId === msg.id) {
        activeId = null;
        const reply: WorkerReply = { id: msg.id, ok: true, result };
        self.postMessage(reply);
      }
    } catch (err) {
      if (activeId === msg.id) {
        failActive(err);
      }
    }
  });
}
