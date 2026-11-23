// Dedicated LSP Web Worker backed by GHC 9.14 WASM (separate from the Runner Worker).
// Speaks standard LSP JSON-RPC 2.0 strings over `postMessage` so CodeMirror's `LanguageClient`
// attaches directly via `WorkerTransport`.

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
import { type BundleSpec, bundleForLanguage, readVerifiedBundleFile } from "./bundles";
import { parseGhcDiagnostics } from "./ghcDiagnostics";
import type { WorkerHelperFile } from "./ghcWorker";
import { provideCompletions, provideHover, provideSignatureHelp } from "./haskellIntel";

interface JsonRpcMessage {
  jsonrpc?: string;
  id?: number | string;
  method?: string;
  params?: unknown;
}

interface OpenDocument {
  uri: string;
  version: number;
  text: string;
  inferredSignatures: Map<string, string>;
}

const DEBOUNCE_MS = 250;
const encoder = new TextEncoder();

let rootfs: PreopenDirectory | null = null;
let dyld: DyLDInstance | null = null;
let runPlayground: ((ghcArgs: string, code: string) => Promise<void>) | null = null;
let stderrChunks: Uint8Array[] = [];
let helpers: WorkerHelperFile[] = [];

const documents = new Map<string, OpenDocument>();
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
let checking = false;
let pendingCheckUri: string | null = null;

function send(message: Record<string, unknown>): void {
  self.postMessage(JSON.stringify({ jsonrpc: "2.0", ...message }));
}

function reply(id: number | string, result: unknown): void {
  send({ id, result });
}

function replyError(id: number | string, code: number, message: string): void {
  send({ id, error: { code, message } });
}

function notify(method: string, params: unknown): void {
  send({ method, params });
}

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

function syncWorkDir(): void {
  if (!rootfs) return;
  const work = new Directory([]);
  for (const helper of helpers) {
    if (!helper.name || helper.name.includes("/") || helper.name.includes("..")) continue;
    work.contents.set(helper.name, new File(encoder.encode(helper.text)));
  }
  rootfs.dir.contents.set("work", work);
}

function helpersText(): string | null {
  if (helpers.length === 0) return null;
  return helpers.map((h) => h.text).join("\n");
}

async function bootGhc(bundle: BundleSpec): Promise<void> {
  if (runPlayground) return;
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
      stdoutChunk: () => {},
      stderrChunk: (buf) => stderrChunks.push(buf.slice()),
    }),
    searchDirs: ["/tmp/clib", bundle.ghc_lib_search_dir],
    mainSoPath: bundle.main_so_path,
    args: ["libplayground001.so", "+RTS", "-c", "-RTS"],
    isIserv: false,
  });

  runPlayground = await dyld.exportFuncs.myMain(bundle.ghc_libdir);
  syncWorkDir();
}

function scheduleCheck(uri: string, immediate = false): void {
  const existing = debounceTimers.get(uri);
  if (existing !== undefined) clearTimeout(existing);
  debounceTimers.set(
    uri,
    setTimeout(
      () => {
        debounceTimers.delete(uri);
        void runCheck(uri);
      },
      immediate ? 0 : DEBOUNCE_MS,
    ),
  );
}

async function runCheck(uri: string): Promise<void> {
  if (!runPlayground) return;
  if (checking) {
    pendingCheckUri = uri;
    return;
  }
  const doc = documents.get(uri);
  if (!doc) return;

  checking = true;
  const versionAtStart = doc.version;
  const textAtStart = doc.text;

  try {
    syncWorkDir();
    stderrChunks = [];
    try {
      await runPlayground(
        "-v0 -fno-code -Wall -ferror-spans -fdiagnostics-color=never -i/work",
        textAtStart,
      );
    } catch {
      // Expected on both type errors (`load returned Failed`) and `-fno-code` no-object panic.
    }
    const latest = documents.get(uri);
    if (!latest || latest.version !== versionAtStart) return;

    const { diagnostics, inferredSignatures } = parseGhcDiagnostics(
      concatText(stderrChunks),
      textAtStart,
    );
    latest.inferredSignatures = inferredSignatures;
    notify("textDocument/publishDiagnostics", {
      uri,
      version: latest.version,
      diagnostics,
    });
  } finally {
    checking = false;
    const nextUri = pendingCheckUri;
    pendingCheckUri = null;
    if (nextUri !== null) {
      void runCheck(nextUri);
    }
  }
}

function applyContentChanges(
  current: string,
  changes: {
    text: string;
    range?: {
      start: { line: number; character: number };
      end: { line: number; character: number };
    };
  }[],
): string {
  let text = current;
  for (const change of changes) {
    if (!change.range) {
      text = change.text;
      continue;
    }
    const lines = text.split("\n");
    const offsetOf = (line: number, char: number) => {
      let off = 0;
      for (let i = 0; i < line && i < lines.length; i++) {
        off += (lines[i]?.length ?? 0) + 1;
      }
      return off + char;
    };
    const from = offsetOf(change.range.start.line, change.range.start.character);
    const to = offsetOf(change.range.end.line, change.range.end.character);
    text = text.slice(0, from) + change.text + text.slice(to);
  }
  return text;
}

async function handleMessage(raw: string): Promise<void> {
  const msg = JSON.parse(raw) as JsonRpcMessage;
  const { id, method, params } = msg;

  if (method === "initialize") {
    try {
      const bundle = bundleForLanguage("haskell");
      if (!bundle) {
        throw new Error("No on-device Haskell bundle is configured.");
      }
      await bootGhc(bundle);
      if (id !== undefined) {
        reply(id, {
          capabilities: {
            textDocumentSync: 1,
            hoverProvider: true,
            completionProvider: { triggerCharacters: ["."] },
            signatureHelpProvider: { triggerCharacters: [" ", "("] },
          },
          serverInfo: {
            name: bundle.engine,
            version: bundle.version,
          },
        });
      }
    } catch (err) {
      if (id !== undefined) {
        replyError(id, -32603, err instanceof Error ? err.message : String(err));
      }
    }
    return;
  }

  if (method === "initialized") {
    return;
  }

  if (method === "shutdown") {
    for (const timer of debounceTimers.values()) clearTimeout(timer);
    debounceTimers.clear();
    if (id !== undefined) reply(id, null);
    return;
  }

  if (method === "exit") {
    self.close();
    return;
  }

  if (method === "workshop/setHelpers") {
    const p = params as { helpers?: WorkerHelperFile[] } | undefined;
    helpers = p?.helpers ?? [];
    syncWorkDir();
    for (const uri of documents.keys()) {
      scheduleCheck(uri, true);
    }
    return;
  }

  if (method === "textDocument/didOpen") {
    const p = params as {
      textDocument?: { uri?: string; version?: number; text?: string };
    };
    const td = p?.textDocument;
    if (td?.uri && typeof td.text === "string") {
      documents.set(td.uri, {
        uri: td.uri,
        version: td.version ?? 0,
        text: td.text,
        inferredSignatures: new Map(),
      });
      scheduleCheck(td.uri, true);
    }
    return;
  }

  if (method === "textDocument/didChange") {
    const p = params as {
      textDocument?: { uri?: string; version?: number };
      contentChanges?: { text: string }[];
    };
    const uri = p?.textDocument?.uri;
    if (uri && Array.isArray(p.contentChanges)) {
      const doc = documents.get(uri);
      if (doc) {
        doc.text = applyContentChanges(doc.text, p.contentChanges);
        doc.version = p.textDocument?.version ?? doc.version + 1;
        scheduleCheck(uri, false);
      }
    }
    return;
  }

  if (method === "textDocument/didSave") {
    const p = params as { textDocument?: { uri?: string }; text?: string };
    const uri = p?.textDocument?.uri;
    if (uri) {
      const doc = documents.get(uri);
      if (doc) {
        if (typeof p.text === "string") doc.text = p.text;
        scheduleCheck(uri, true);
      }
    }
    return;
  }

  if (method === "textDocument/didClose") {
    const p = params as { textDocument?: { uri?: string } };
    const uri = p?.textDocument?.uri;
    if (uri) {
      const timer = debounceTimers.get(uri);
      if (timer !== undefined) clearTimeout(timer);
      debounceTimers.delete(uri);
      documents.delete(uri);
      notify("textDocument/publishDiagnostics", { uri, diagnostics: [] });
    }
    return;
  }

  if (method === "textDocument/hover" && id !== undefined) {
    const p = params as {
      textDocument?: { uri?: string };
      position?: { line?: number; character?: number };
    };
    const doc = p?.textDocument?.uri ? documents.get(p.textDocument.uri) : undefined;
    if (!doc || p.position?.line === undefined || p.position?.character === undefined) {
      reply(id, null);
      return;
    }
    reply(
      id,
      provideHover(
        doc.text,
        p.position.line,
        p.position.character,
        helpersText(),
        doc.inferredSignatures,
      ),
    );
    return;
  }

  if (method === "textDocument/completion" && id !== undefined) {
    const p = params as {
      textDocument?: { uri?: string };
      position?: { line?: number; character?: number };
    };
    const doc = p?.textDocument?.uri ? documents.get(p.textDocument.uri) : undefined;
    if (!doc || p.position?.line === undefined || p.position?.character === undefined) {
      reply(id, []);
      return;
    }
    reply(
      id,
      provideCompletions(
        doc.text,
        p.position.line,
        p.position.character,
        helpersText(),
        doc.inferredSignatures,
      ),
    );
    return;
  }

  if (method === "textDocument/signatureHelp" && id !== undefined) {
    const p = params as {
      textDocument?: { uri?: string };
      position?: { line?: number; character?: number };
    };
    const doc = p?.textDocument?.uri ? documents.get(p.textDocument.uri) : undefined;
    if (!doc || p.position?.line === undefined || p.position?.character === undefined) {
      reply(id, null);
      return;
    }
    reply(
      id,
      provideSignatureHelp(
        doc.text,
        p.position.line,
        p.position.character,
        helpersText(),
        doc.inferredSignatures,
      ),
    );
    return;
  }

  if (id !== undefined) {
    reply(id, null);
  }
}

if (typeof self !== "undefined" && typeof self.postMessage === "function") {
  self.addEventListener("message", (ev: MessageEvent<string>) => {
    if (typeof ev.data !== "string") return;
    void handleMessage(ev.data);
  });
}
