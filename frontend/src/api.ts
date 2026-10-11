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
  };
  snippets: Snippet[];
  discuss_models: string[];
  edit_model: string;
  has_aoc_session: boolean;
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
  | { status: "applied"; doc: string; summary: string }
  | { status: "unsure"; message: string }
) & { model: string | null; elapsed_ms: number };

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
 * `keepalive` lets a request finish after the page is hidden or closed, which is when the
 * phone is put down.
 */
async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  { keepalive = false }: { keepalive?: boolean } = {},
): Promise<T> {
  const init: RequestInit = { method, headers: {}, keepalive };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const response = await fetch(`/api${path}`, init);
  const text = await response.text();
  const json: unknown = text ? JSON.parse(text) : null;
  if (!response.ok) {
    const message =
      json && typeof json === "object" && "error" in json && typeof json.error === "string"
        ? json.error
        : `Request failed with ${response.status}`;
    throw new ApiError(message, response.status, json);
  }
  return json as T;
}

const day = (p: Puzzle) => `/puzzles/${p.year}/${p.day}`;

export const api = {
  bootstrap: () => request<Bootstrap>("GET", "/bootstrap"),
  saveState: (state: UiState, keepalive = false) =>
    request<null>("PUT", "/state", state, { keepalive }),
  doctor: () => request<Check[]>("GET", "/doctor"),
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
    request<{ outcome: SubmitOutcome; problem: Problem | null }>("POST", `${day(p)}/submit`, {
      part,
      answer,
    }),
  edit: (doc: string, utterance: string, recent: string | null) =>
    request<EditResult>("POST", "/edit", { doc, utterance, recent }),
  discuss: (body: {
    year: number;
    day: number;
    model: string;
    turns: Turn[];
    code: string;
    errors: string;
    last_run: string;
  }) => request<{ text: string; model: string | null }>("POST", "/discuss", body),
  /** Fire-and-forget: records phone-side events in the server's log file. */
  log: (kind: "error" | "command" | "speech", message: string) => {
    request<null>("POST", "/log", { kind, message }).catch(() => {});
  },
  gitSync: (message: string) => request<{ summary: string }>("POST", "/git/sync", { message }),
};
