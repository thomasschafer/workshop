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

export interface CodeFile {
  text: string;
  version: string;
  path: string;
}

export interface DayMeta {
  sample_block: number | null;
  sample_input: string | null;
  sample_answers: [string | null, string | null];
  cursor: number | null;
}

export interface OpenPuzzle {
  code: CodeFile;
  file_uri: string;
  notes: string;
  meta: DayMeta;
}

export interface Problem {
  title: string | null;
  parts_html: string[];
  text: string;
  answers: string[];
  suggested_sample_answers: (string | null)[];
  suggested_sample_blocks: (number | null)[];
  blocks: string[];
}

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

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method, headers: {} };
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
  saveState: (state: UiState) => request<null>("PUT", "/state", state),
  doctor: () => request<Check[]>("GET", "/doctor"),
  stars: (year: number, refresh = false) =>
    request<Record<string, number>>("GET", `/years/${year}/stars?refresh=${refresh}`),
  open: (p: Puzzle) => request<OpenPuzzle>("GET", day(p)),
  saveCode: (p: Puzzle, text: string, version: string) =>
    request<CodeFile>("PUT", `${day(p)}/code`, { text, version }),
  saveNotes: (p: Puzzle, text: string) => request<null>("PUT", `${day(p)}/notes`, { text }),
  saveMeta: (p: Puzzle, meta: DayMeta) => request<null>("PUT", `${day(p)}/meta`, meta),
  problem: (p: Puzzle, refresh = false) =>
    request<Problem>("GET", `${day(p)}/problem?refresh=${refresh}`),
  run: (p: Puzzle, input: "sample" | "real") =>
    request<RunResult>("POST", `${day(p)}/run`, { input }),
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
  gitSync: (message: string) => request<{ summary: string }>("POST", "/git/sync", { message }),
};
