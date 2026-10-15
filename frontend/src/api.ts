// Types mirror the Rust API in src/server.rs.

export interface Puzzle {
  year: number;
  day: number;
}

export type Tab = "problem" | "code" | "notes" | "discuss";

export interface UiState {
  puzzle: Puzzle | null;
  tab: Tab;
  discuss_model: string | null;
}

export interface Snippet {
  name: string;
  body: string;
}

export interface Bootstrap {
  state: UiState;
  language: {
    id: string;
    name: string;
    editor_mode: string;
    lsp_language_id: string;
    has_lsp: boolean;
    root_uri: string;
    /** For recognising a missing package in errors, if the language has packages. */
    packages: PackageHints | null;
    /** Turns on the template's part 2 code once part 1 is solved. */
    start_part_two: { find: string; replace: string } | null;
  };
  snippets: Snippet[];
  models: ModelsState;
  has_aoc_session: boolean;
  needs_setup: boolean;
  theme_css: string | null;
  /** Whether the solutions repo is committed and pushed after each star. */
  commit_after_star: boolean;
  /** Whether Whisper on the server is ready to hear dictation. */
  server_dictation: boolean;
  /** Where solutions are saved, as shown to the user. */
  solutions_dir: string;
}

export interface SpeechState {
  /** Whether dictation can use Whisper: the program and its model are both installed. */
  ready: boolean;
  whisper_installed: boolean;
  model: string;
  model_mb: number;
  model_installed: boolean;
  install_hint: string;
  download: InstallStatus;
}

export interface PackageHints {
  /** Patterns finding a missing module in an error, with the module as their only group. */
  missing_module: string[];
  /** Patterns finding the package itself, for compilers that name it. */
  missing_package: string[];
}

/** The package that would provide a missing module. */
export type Resolution =
  | { kind: "known"; package: string }
  | { kind: "found"; package: string; summary: string | null }
  | { kind: "guessed"; package: string }
  | { kind: "not_found" };

export interface PackagesState {
  /** The manifest's path, relative to the solutions directory. */
  manifest: string;
  text: string;
  packages: string[];
  /** What's wrong with the manifest, if anything. */
  problem: string | null;
  /** What's installed now, or null if nothing has been yet. */
  installed: string[] | null;
  /** Programs installing needs that aren't on the PATH. */
  missing_programs: string[];
}

export interface LastInstall {
  succeeded: boolean;
  log: string[];
}

export interface InstallStatus {
  installing: boolean;
  /** The installer's latest line of output, while installing. */
  progress: string | null;
  last_install: LastInstall | null;
}

export interface PackagesResponse extends InstallStatus {
  /** Null when the language has no packages beyond its standard library. */
  state: PackagesState | null;
}

export interface BenchInfo {
  whisper_installed: boolean;
  /** Whisper models downloaded, smallest first. */
  models: string[];
  models_dir: string;
}

export interface WhisperTranscript {
  model: string;
  prompted: boolean;
  text: string;
  wall_ms: number;
  load_ms: number | null;
  total_ms: number | null;
}

/** What to use for light or dark mode. */
export type ThemeChoice =
  | { kind: "default" }
  | { kind: "ghostty" }
  | { kind: "named"; name: string };

export interface ThemeSettings {
  light: ThemeChoice;
  dark: ThemeChoice;
}

export interface ThemesState {
  names: string[];
  ghostty: [string, string] | null;
  settings: ThemeSettings;
}

export interface SetupState {
  /** Where solutions are saved, as shown to the user. */
  solutions_dir: string;
  /** Whether that's a git repo yet, which it becomes when a puzzle is first opened. */
  solutions_repo_exists: boolean;
  /** The config file, where the solutions folder can be changed. */
  config_file: string;
  languages: {
    id: string;
    name: string;
    missing: string[];
    missing_language_server: string | null;
    /** Whether setup can install its programs with mise. */
    installable: boolean;
  }[];
  language: string;
  has_aoc_session: boolean;
  providers: {
    id: string;
    name: string;
    installed: boolean;
    logged_in: boolean | null;
    install_hint: string | null;
  }[];
  tailscale_installed: boolean;
  mise_installed: boolean;
  /** Why the solutions folder's mise config couldn't be read, if it couldn't. */
  toolchain_problem: string | null;
  /** Installing the chosen language's programs with mise. */
  toolchain_install: InstallStatus;
  phone_url: string | null;
  phone_qr_svg: string | null;
  port: number;
}

export interface ModelChoice {
  provider: string;
  model: string;
}

export interface ModelSettings {
  edit: ModelChoice;
  discuss_provider: string;
}

/** A model CLI as offered in the app. */
export interface ProviderOption {
  id: string;
  name: string;
  /** Why it can't be chosen, such as its CLI not being installed. */
  unavailable: string | null;
  edit_models: string[];
  discuss_models: string[];
}

export interface ModelsState {
  providers: ProviderOption[];
  settings: ModelSettings;
  discuss_models: string[];
}

/** A file the user edits, here or elsewhere. */
export interface VersionedFile {
  text: string;
  version: string;
  path: string;
}

export interface DayMeta {
  sample_blocks: [number | null, number | null];
  sample_inputs: [string | null, string | null];
  sample_answers: [string | null, string | null];
  cursor: number | null;
}

export interface OpenPuzzle {
  code: VersionedFile;
  file_uri: string;
  notes: VersionedFile;
  meta: DayMeta;
}

export interface Problem {
  title: string | null;
  parts_html: string[];
  text: string;
  answers: string[];
  stars: number;
  final_star: FinalStar | null;
  suggested_sample_answers: (string | null)[];
  suggested_sample_blocks: (number | null)[];
  blocks: string[];
}

/** On the last day of a year, part 2's star is awarded for having every other star. */
export type FinalStar = { state: "needs_more_stars"; more: number | null } | { state: "claimable" };

export type Ending =
  | { status: "exited"; code: number | null }
  | { status: "timed_out" }
  | { status: "cancelled" };

export interface RunResult {
  phase: "build" | "run";
  ending: Ending;
  stdout: string;
  stderr: string;
  duration_ms: number;
  answers: string[];
}

export type SubmitOutcome =
  | { result: "correct" }
  | { result: "incorrect"; hint: string | null; message: string }
  | { result: "too_soon"; message: string }
  | { result: "already_solved"; message: string }
  | { result: "unknown"; message: string };

export type EditResult = (
  | { status: "applied"; doc: string; summary: string; inserted: string }
  | { status: "unsure"; message: string }
) & { model: string | null; elapsed_ms: number };

/** An earlier utterance the edit model asked about, which a reply answers. */
export interface Exchange {
  said: string;
  asked: string;
}

export interface Turn {
  speaker: "user" | "coach";
  text: string;
}

export interface Check {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
  fix: string | null;
}

/**
 * A message from the server as a sentence. Its errors start in lower case, as they're often
 * written into longer messages there, but are shown on their own here.
 */
export function sentence(message: string): string {
  return message.charAt(0).toUpperCase() + message.slice(1);
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
  }
}

/** The server couldn't be reached at all, as opposed to answering with an error. */
export class ConnectionError extends Error {}

/** Answers a proxy such as `tailscale serve` gives when the server behind it isn't running. */
const UNREACHABLE = new Set([502, 503, 504]);

/** Whether the server can be reached, as last seen by any request. */
export class Connection {
  private online = true;
  private readonly listeners = new Set<(online: boolean) => void>();

  get isOnline(): boolean {
    return this.online;
  }

  /** Calls `listener` whenever the server is lost or found again, returning how to stop. */
  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  set(online: boolean): void {
    if (online === this.online) return;
    this.online = online;
    for (const listener of this.listeners) listener(online);
  }

  /** Resolves once the server can be reached, or rejects if `signal` aborts first. */
  whenOnline(signal?: AbortSignal): Promise<void> {
    if (this.online) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const stop = this.subscribe((online) => {
        if (!online) return;
        stop();
        resolve();
      });
      signal?.addEventListener("abort", () => {
        stop();
        reject(signal.reason);
      });
    });
  }
}

export const connection = new Connection();

interface RequestOptions {
  /** Lets a request finish after the page is hidden or closed, which is when the phone is put down. */
  keepalive?: boolean;
  /** Abandons the request, such as when the user cancels what it was for. */
  signal?: AbortSignal;
}

/** Sends a request, rejecting with an `ApiError` if the server says it failed. */
async function send(
  method: string,
  path: string,
  body?: unknown,
  { keepalive = false, signal }: RequestOptions = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: {}, keepalive };
  if (signal) init.signal = signal;
  if (body instanceof ArrayBuffer) {
    init.headers = { "content-type": "audio/wav" };
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch (e) {
    if (signal?.aborted) throw e;
    connection.set(false);
    throw new ConnectionError("Can't reach the server.");
  }
  if (UNREACHABLE.has(response.status)) {
    connection.set(false);
    throw new ConnectionError("Can't reach the server.");
  }
  connection.set(true);
  if (!response.ok) {
    const text = await response.text();
    const json: unknown = text ? JSON.parse(text) : null;
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `Request failed with ${response.status}`;
    throw new ApiError(sentence(message), response.status, json);
  }
  return response;
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const text = await (await send(method, path, body, options)).text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Reads a reply of newline-delimited JSON, handing over each line as it arrives. */
async function streamLines(
  method: string,
  path: string,
  body: unknown,
  onLine: (value: unknown) => void,
): Promise<void> {
  const response = await send(method, path, body);
  if (!response.body) throw new Error("The server's reply couldn't be read as it arrived.");
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffered = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffered += value;
    for (let end = buffered.indexOf("\n"); end !== -1; end = buffered.indexOf("\n")) {
      const line = buffered.slice(0, end);
      buffered = buffered.slice(end + 1);
      if (line.trim()) onLine(JSON.parse(line));
    }
  }
  if (buffered.trim()) onLine(JSON.parse(buffered));
}

type DiscussEvent =
  | { delta: string }
  | { done: { text: string; model: string | null } }
  | { error: string };

const day = (p: Puzzle) => `/puzzles/${p.year}/${p.day}`;

export const api = {
  /** Checks the server can be reached; any answer from it will do. */
  ping: () => request<null>("GET", "/ping"),
  bootstrap: () => request<Bootstrap>("GET", "/bootstrap"),
  saveState: (state: UiState, keepalive = false) =>
    request<null>("PUT", "/state", state, { keepalive }),
  doctor: () => request<Check[]>("GET", "/doctor"),
  setModels: (settings: ModelSettings) => request<ModelsState>("PUT", "/models", settings),
  setup: () => request<SetupState>("GET", "/setup"),
  themes: () => request<ThemesState>("GET", "/themes"),
  setTheme: (settings: ThemeSettings) => request<{ css: string | null }>("PUT", "/theme", settings),
  setLanguage: (language: string) => request<null>("PUT", "/setup/language", { language }),
  setAocSession: (session: string) => request<null>("POST", "/setup/aoc-session", { session }),
  stars: (year: number, refresh = false) =>
    request<Record<string, number>>("GET", `/years/${year}/stars?refresh=${refresh}`),
  open: (p: Puzzle) => request<OpenPuzzle>("GET", day(p)),
  saveCode: (p: Puzzle, text: string, version: string, keepalive = false) =>
    request<VersionedFile>("PUT", `${day(p)}/code`, { text, version }, { keepalive }),
  saveNotes: (p: Puzzle, text: string, version: string, keepalive = false) =>
    request<VersionedFile>("PUT", `${day(p)}/notes`, { text, version }, { keepalive }),
  saveMeta: (p: Puzzle, meta: DayMeta, keepalive = false) =>
    request<null>("PUT", `${day(p)}/meta`, meta, { keepalive }),
  problem: (p: Puzzle, refresh = false) =>
    request<Problem>("GET", `${day(p)}/problem?refresh=${refresh}`),
  input: (p: Puzzle) => request<{ text: string; lines: number }>("GET", `${day(p)}/input`),
  run: (p: Puzzle, input: "sample" | "real", part: number) =>
    request<RunResult>("POST", `${day(p)}/run`, { input, part }),
  cancelRun: () => request<null>("POST", "/run/cancel"),
  submit: (p: Puzzle, part: number, answer: string) =>
    request<{
      outcome: SubmitOutcome;
      problem: Problem | null;
      committed: { succeeded: boolean; summary: string } | null;
    }>("POST", `${day(p)}/submit`, {
      part,
      answer,
    }),
  edit: (
    doc: string,
    utterance: string,
    pieces: string[],
    recent: string | null,
    earlier: Exchange[],
    signal?: AbortSignal,
  ) =>
    request<EditResult>(
      "POST",
      "/edit",
      { doc, utterance, pieces, recent, earlier },
      signal ? { signal } : {},
    ),
  discuss: async (
    body: {
      year: number;
      day: number;
      model: string;
      turns: Turn[];
      code: string;
      errors: string;
      last_run: string;
    },
    onDelta: (text: string) => void,
  ): Promise<{ text: string; model: string | null }> => {
    const reply: { value: { text: string; model: string | null } | null } = { value: null };
    await streamLines("POST", "/discuss", body, (line) => {
      const event = line as DiscussEvent;
      if ("delta" in event) onDelta(event.delta);
      else if ("done" in event) reply.value = event.done;
      else throw new Error(sentence(event.error));
    });
    if (reply.value === null) throw new Error("The reply stopped before it was finished.");
    return reply.value;
  },
  /** Fire-and-forget: records phone-side events in the server's log file. */
  log: (kind: "error" | "command" | "speech", message: string) => {
    request<null>("POST", "/log", { kind, message }).catch(() => {});
  },
  packages: () => request<PackagesResponse>("GET", "/packages"),
  savePackages: (text: string) => request<PackagesResponse>("PUT", "/packages", { text }),
  installPackages: () => request<PackagesResponse>("POST", "/packages/install"),
  addPackage: (pkg: string) => request<PackagesResponse>("POST", "/packages/add", { package: pkg }),
  removePackage: (pkg: string) =>
    request<PackagesResponse>("POST", "/packages/remove", { package: pkg }),
  cancelInstall: () => request<null>("POST", "/packages/cancel"),
  resolvePackage: (module: string) => request<Resolution>("POST", "/packages/resolve", { module }),
  speech: () => request<SpeechState>("GET", "/speech"),
  downloadSpeechModel: () => request<SpeechState>("POST", "/speech/download"),
  cancelSpeechDownload: () => request<null>("POST", "/speech/download/cancel"),
  transcribe: (wav: ArrayBuffer, signal?: AbortSignal) =>
    request<{ text: string }>("POST", "/speech/transcribe", wav, signal ? { signal } : {}),
  bench: () => request<BenchInfo>("GET", "/bench"),
  benchTranscribe: (session: string, phrase: number, prompt: string, wav: ArrayBuffer) =>
    request<WhisperTranscript[]>(
      "POST",
      `/bench/transcribe?${new URLSearchParams({ session, phrase: String(phrase), prompt })}`,
      wav,
    ),
  benchResult: (result: Record<string, unknown>) => request<null>("POST", "/bench/result", result),
  installToolchain: () => request<SetupState>("POST", "/setup/toolchain"),
  cancelToolchainInstall: () => request<null>("POST", "/setup/toolchain/cancel"),
  resetPractice: () => request<Problem>("POST", "/practice/reset"),
  setSolutionsRepo: (commitAfterStar: boolean) =>
    request<null>("PUT", "/solutions-repo", { commit_after_star: commitAfterStar }),
  gitSync: (message: string) => request<{ summary: string }>("POST", "/git/sync", { message }),
};
