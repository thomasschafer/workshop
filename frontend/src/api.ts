// Types mirror the Rust API in src/server/.

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

/** A part's example, found by the edit model when the puzzle's page doesn't make it clear. */
export interface FoundSample {
  input: string;
  answer: string;
}

export interface EditorConfig {
  keybindings: "default" | "helix";
  /** Whether to format before each run, and once Helix has been left in normal mode a moment. */
  format_automatically: boolean;
  /** Helix's options, as named in Helix's config, and its keymaps under `keys`. */
  helix: HelixConfigJson;
}

export interface HelixConfigJson {
  scrolloff?: number;
  "line-number"?: "absolute" | "relative";
  "color-modes"?: boolean;
  "auto-pairs"?: boolean;
  "jump-label-alphabet"?: string;
  "smart-tab"?: { enable: boolean };
  search?: { "smart-case"?: boolean; "wrap-around"?: boolean };
  "cursor-shape"?: {
    normal?: "block" | "bar" | "underline" | "hidden";
    insert?: "block" | "bar" | "underline" | "hidden";
    select?: "block" | "bar" | "underline" | "hidden";
  };
  keys?: unknown;
}

export interface Bootstrap {
  state: UiState;
  language: {
    id: string;
    name: string;
    editor_mode: string;
    lsp_language_id: string;
    has_lsp: boolean;
    /** Whether the language has a formatter of its own, used instead of the language server's. */
    has_formatter: boolean;
    root_uri: string;
    /** Sent to the language server as it starts. */
    lsp_options: unknown;
    /** For recognising a missing package in errors, if the language has packages. */
    packages: PackageHints | null;
    /** Turns on the template's part 2 code once part 1 is solved. */
    start_part_two: { find: string; replace: string } | null;
  };
  snippets: Snippet[];
  models: ModelsState;
  /** How the code editor behaves with a keyboard, from the config file. */
  editor: EditorConfig;
  has_aoc_session: boolean;
  needs_setup: boolean;
  theme_css: string | null;
  /** Whether the solutions repo is committed and pushed after each star. */
  commit_after_star: boolean;
  /** Whether Whisper on the server is ready to hear dictation. */
  server_dictation: boolean;
  /** Where solutions are saved, as shown to the user. */
  solutions_dir: string;
  /** The private leaderboard shown, if one is chosen. */
  leaderboard: string | null;
  /** A newer release, if one is out, and what to do to update. */
  update: { version: string; how: string } | null;
}

export interface LeaderboardMember {
  name: string;
  score: number;
  stars: number;
}

/** The time to each part's star, as Advent of Code gives it, or null if it's not been earned. */
export type StarTimes = [string | null, string | null];

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

/** What of a language's programs isn't installed. */
export interface ProgramNeeds {
  /** Programs it needs that aren't installed. */
  missing: string[];
  /** The language server, if it isn't installed. Workshop works without it. */
  missing_language_server: string | null;
  /** Whether Workshop can install its programs with mise. */
  installable: boolean;
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
  languages: ({ id: string; name: string } & ProgramNeeds)[];
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

/** The grader's model, as chosen in the app: the discussion provider's first, or its own. */
export type GraderChoice = { kind: "discussion" } | ({ kind: "model" } & ModelChoice);

export interface ModelSettings {
  edit: ModelChoice;
  discuss_provider: string;
  /** Missing until chosen in the app, when the config decides. */
  grader?: GraderChoice;
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
  /** The grader's model, or null for the discussion provider's first. */
  grader: ModelChoice | null;
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
  /** Answers that are probably wrong as printed, such as a decimal. */
  warnings: string[];
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

/**
 * Says when Advent of Code needs the user to log in, for the first time or again, as any request
 * that needed it finds, so the app can offer to.
 */
export class LoginNeeded {
  private readonly listeners = new Set<(message: string) => void>();

  /** Calls `listener` with why, returning how to stop. */
  subscribe(listener: (message: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  notify(message: string): void {
    for (const listener of this.listeners) listener(message);
  }
}

export const loginNeeded = new LoginNeeded();

/** The server couldn't be reached at all, as opposed to answering with an error. */
export class ConnectionError extends Error {}

/** The server didn't answer within the request's timeout budget; the link may be slow rather than
 * completely offline. */
export class TimeoutError extends Error {}

/** Answers a proxy such as `tailscale serve` gives when the server behind it isn't running. */
const UNREACHABLE = new Set([502, 503, 504]);

/** Default client timeout for ordinary API calls, so flaky links don't hang for a minute. */
export const DEFAULT_TIMEOUT_MS = 8_000;

export interface ConnectionSnapshot {
  online: boolean;
  slow: boolean;
  lastRttMs: number | null;
  lastOnlineAt: number | null;
}

/** Whether the server can be reached, as last seen by any request, plus recent responsiveness. */
export class Connection {
  private online = true;
  private slow = false;
  private lastRttMs: number | null = null;
  private lastOnlineAt: number | null = null;
  private readonly listeners = new Set<(online: boolean) => void>();
  private readonly statusListeners = new Set<(snapshot: ConnectionSnapshot) => void>();

  get isOnline(): boolean {
    return this.online;
  }

  get isSlow(): boolean {
    return this.slow;
  }

  snapshot(): ConnectionSnapshot {
    return {
      online: this.online,
      slow: this.slow,
      lastRttMs: this.lastRttMs,
      lastOnlineAt: this.lastOnlineAt,
    };
  }

  /** Calls `listener` whenever the server is lost or found again, returning how to stop. */
  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Calls `listener` whenever reachability, slowness or RTT updates. */
  subscribeStatus(listener: (snapshot: ConnectionSnapshot) => void): () => void {
    this.statusListeners.add(listener);
    return () => this.statusListeners.delete(listener);
  }

  set(online: boolean): void {
    const changed = online !== this.online;
    if (!online && this.slow) this.slow = false;
    this.online = online;
    if (changed) {
      for (const listener of this.listeners) listener(online);
      this.notifyStatus();
    }
  }

  /** Marks the link slow after a timeout without flipping the app offline. */
  setSlow(slow: boolean): void {
    if (slow === this.slow) return;
    this.slow = slow;
    this.notifyStatus();
  }

  recordSuccess(rttMs: number): void {
    const wasOnline = this.online;
    this.online = true;
    this.slow = false;
    this.lastRttMs = Math.max(0, Math.round(rttMs));
    this.lastOnlineAt = Date.now();
    if (!wasOnline) {
      for (const listener of this.listeners) listener(true);
    }
    this.notifyStatus();
  }

  private notifyStatus(): void {
    const snap = this.snapshot();
    for (const listener of this.statusListeners) listener(snap);
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

export interface RequestOptions {
  /** Lets a request finish after the page is hidden or closed, which is when the phone is put down. */
  keepalive?: boolean;
  /** Abandons the request, such as when the user cancels what it was for. */
  signal?: AbortSignal;
  /** Client timeout in ms; 0 disables the client timeout (for long runs, installs and streams). */
  timeoutMs?: number;
}

/** Sends a request, rejecting with an `ApiError` if the server says it failed. */
async function send(
  method: string,
  path: string,
  body?: unknown,
  { keepalive = false, signal, timeoutMs = DEFAULT_TIMEOUT_MS }: RequestOptions = {},
): Promise<Response> {
  const init: RequestInit = { method, headers: {}, keepalive };
  let controller: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const onCallerAbort = () => controller?.abort(signal?.reason);

  if (timeoutMs > 0) {
    controller = new AbortController();
    if (signal?.aborted) {
      controller.abort(signal.reason);
    } else if (signal) {
      signal.addEventListener("abort", onCallerAbort, { once: true });
    }
    timer = setTimeout(() => {
      timedOut = true;
      controller?.abort();
    }, timeoutMs);
    init.signal = controller.signal;
  } else if (signal) {
    init.signal = signal;
  }

  if (body instanceof ArrayBuffer) {
    init.headers = { "content-type": "audio/wav" };
    init.body = body;
  } else if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const started = performance.now();
  let response: Response;
  try {
    response = await fetch(`/api${path}`, init);
  } catch (e) {
    if (timedOut) {
      connection.setSlow(true);
      throw new TimeoutError("The server took too long to respond.");
    }
    if (signal?.aborted) throw e;
    connection.set(false);
    throw new ConnectionError("Can't reach the server.");
  } finally {
    clearTimeout(timer);
    if (signal && controller) signal.removeEventListener("abort", onCallerAbort);
  }
  if (UNREACHABLE.has(response.status)) {
    connection.set(false);
    throw new ConnectionError("Can't reach the server.");
  }
  connection.recordSuccess(performance.now() - started);
  if (!response.ok) {
    const text = await response.text();
    const json: unknown = text ? JSON.parse(text) : null;
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `Request failed with ${response.status}`;
    if (json && typeof json === "object" && "action" in json && json.action === "login") {
      loginNeeded.notify(sentence(message));
    }
    throw new ApiError(sentence(message), response.status, json);
  }
  return response;
}

export async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  options: RequestOptions = {},
): Promise<T> {
  const text = await (await send(method, path, body, options)).text();
  return (text ? JSON.parse(text) : null) as T;
}

/** Reads a reply of newline-delimited JSON, handing over each line as it arrives. */
export async function streamLines(
  method: string,
  path: string,
  body: unknown,
  onLine: (value: unknown) => void,
): Promise<void> {
  const response = await send(method, path, body, { timeoutMs: 0 });
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

/** Budget for requests that may wait on Advent of Code's polite spacing. */
const AOC_TIMEOUT_MS = 25_000;

export const api = {
  /** Checks the server can be reached; any answer from it will do. */
  ping: () => request<null>("GET", "/ping", undefined, { timeoutMs: 3_000 }),
  bootstrap: () => request<Bootstrap>("GET", "/bootstrap", undefined, { timeoutMs: 4_000 }),
  saveState: (state: UiState, keepalive = false) =>
    request<null>("PUT", "/state", state, { keepalive }),
  doctor: () => request<Check[]>("GET", "/doctor", undefined, { timeoutMs: 15_000 }),
  setModels: (settings: ModelSettings) => request<ModelsState>("PUT", "/models", settings),
  setup: () => request<SetupState>("GET", "/setup"),
  themes: () => request<ThemesState>("GET", "/themes"),
  setTheme: (settings: ThemeSettings) => request<{ css: string | null }>("PUT", "/theme", settings),
  setLanguage: (language: string) => request<null>("PUT", "/setup/language", { language }),
  setAocSession: (session: string) =>
    request<null>("POST", "/setup/aoc-session", { session }, { timeoutMs: AOC_TIMEOUT_MS }),
  notifications: () => request<{ public_key: string }>("GET", "/notifications"),
  notificationsSubscribed: (endpoint: string) =>
    request<boolean>("POST", "/notifications/subscribed", { endpoint }),
  subscribeNotifications: (subscription: PushSubscriptionJSON) =>
    request<null>("POST", "/notifications/subscribe", subscription),
  unsubscribeNotifications: (endpoint: string) =>
    request<null>("POST", "/notifications/unsubscribe", { endpoint }),
  testNotification: (subscription: PushSubscriptionJSON) =>
    request<null>("POST", "/notifications/test", subscription),
  leaderboard: (year: number) =>
    request<LeaderboardMember[] | null>("GET", `/years/${year}/leaderboard`, undefined, {
      timeoutMs: AOC_TIMEOUT_MS,
    }),
  setLeaderboard: (id: string | null) => request<null>("PUT", "/leaderboard", { id }),
  times: (year: number, refresh = false) =>
    request<Record<string, StarTimes>>(
      "GET",
      `/years/${year}/times?refresh=${refresh}`,
      undefined,
      {
        timeoutMs: AOC_TIMEOUT_MS,
      },
    ),
  stars: (year: number, refresh = false) =>
    request<Record<string, number>>("GET", `/years/${year}/stars?refresh=${refresh}`, undefined, {
      timeoutMs: AOC_TIMEOUT_MS,
    }),
  open: (p: Puzzle) => request<OpenPuzzle>("GET", day(p)),
  saveCode: (p: Puzzle, text: string, version: string, keepalive = false) =>
    request<VersionedFile>("PUT", `${day(p)}/code`, { text, version }, { keepalive }),
  saveNotes: (p: Puzzle, text: string, version: string, keepalive = false) =>
    request<VersionedFile>("PUT", `${day(p)}/notes`, { text, version }, { keepalive }),
  saveMeta: (p: Puzzle, meta: DayMeta, keepalive = false) =>
    request<null>("PUT", `${day(p)}/meta`, meta, { keepalive }),
  problem: (p: Puzzle, refresh = false) =>
    request<Problem>("GET", `${day(p)}/problem?refresh=${refresh}`, undefined, {
      timeoutMs: AOC_TIMEOUT_MS,
    }),
  input: (p: Puzzle) =>
    request<{ text: string; lines: number }>("GET", `${day(p)}/input`, undefined, {
      timeoutMs: AOC_TIMEOUT_MS,
    }),
  findSample: (p: Puzzle, part: number) =>
    request<FoundSample | null>("POST", `${day(p)}/sample/${part}`, undefined, { timeoutMs: 0 }),
  run: (p: Puzzle, input: "sample" | "real", part: number, runId?: string, signal?: AbortSignal) =>
    request<RunResult>(
      "POST",
      `${day(p)}/run`,
      runId ? { input, part, run_id: runId } : { input, part },
      { timeoutMs: 0, ...(signal ? { signal } : {}) },
    ),
  format: (p: Puzzle, code: string) =>
    request<{ code: string }>("POST", `${day(p)}/format`, { code }, { timeoutMs: 0 }).then(
      (r) => r.code,
    ),
  cancelRun: (runId?: string) =>
    request<null>("POST", "/run/cancel", runId ? { run_id: runId } : undefined, {
      timeoutMs: 3_000,
    }),
  /** Restarts every language server, which editors reconnect to. */
  restartLanguageServers: () => request<null>("POST", "/lsp/restart"),
  submit: (p: Puzzle, part: number, answer: string) =>
    request<{
      outcome: SubmitOutcome;
      problem: Problem | null;
      committed: { succeeded: boolean; summary: string } | null;
    }>(
      "POST",
      `${day(p)}/submit`,
      {
        part,
        answer,
      },
      { timeoutMs: 0 },
    ),
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
      { timeoutMs: 0, ...(signal ? { signal } : {}) },
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
    request<null>("POST", "/log", { kind, message }, { timeoutMs: 3_000 }).catch(() => {});
  },
  packages: () => request<PackagesResponse>("GET", "/packages"),
  savePackages: (text: string) => request<PackagesResponse>("PUT", "/packages", { text }),
  installPackages: () =>
    request<PackagesResponse>("POST", "/packages/install", undefined, { timeoutMs: 0 }),
  addPackage: (pkg: string) =>
    request<PackagesResponse>("POST", "/packages/add", { package: pkg }, { timeoutMs: 0 }),
  removePackage: (pkg: string) =>
    request<PackagesResponse>("POST", "/packages/remove", { package: pkg }, { timeoutMs: 0 }),
  cancelInstall: () => request<null>("POST", "/packages/cancel"),
  resolvePackage: (module: string) =>
    request<Resolution>("POST", "/packages/resolve", { module }, { timeoutMs: 15_000 }),
  speech: () => request<SpeechState>("GET", "/speech"),
  downloadSpeechModel: () =>
    request<SpeechState>("POST", "/speech/download", undefined, { timeoutMs: 0 }),
  cancelSpeechDownload: () => request<null>("POST", "/speech/download/cancel"),
  transcribe: (wav: ArrayBuffer, signal?: AbortSignal) =>
    request<{ text: string }>("POST", "/speech/transcribe", wav, {
      timeoutMs: 0,
      ...(signal ? { signal } : {}),
    }),
  bench: () => request<BenchInfo>("GET", "/bench"),
  benchTranscribe: (session: string, phrase: number, prompt: string, wav: ArrayBuffer) =>
    request<WhisperTranscript[]>(
      "POST",
      `/bench/transcribe?${new URLSearchParams({ session, phrase: String(phrase), prompt })}`,
      wav,
      { timeoutMs: 0 },
    ),
  benchResult: (result: Record<string, unknown>) => request<null>("POST", "/bench/result", result),
  installToolchain: () =>
    request<SetupState>("POST", "/setup/toolchain", undefined, { timeoutMs: 0 }),
  cancelToolchainInstall: () => request<null>("POST", "/setup/toolchain/cancel"),
  resetPractice: () => request<Problem>("POST", "/practice/reset"),
  setSolutionsRepo: (commitAfterStar: boolean) =>
    request<null>("PUT", "/solutions-repo", { commit_after_star: commitAfterStar }),
  gitSync: (message: string) =>
    request<{ summary: string }>("POST", "/git/sync", { message }, { timeoutMs: 0 }),
};
