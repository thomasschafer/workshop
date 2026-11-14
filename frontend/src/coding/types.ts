// Types mirror the Coding track in src/coding.rs and src/server/coding.rs, and the results of
// running code in crates/coding.

import type { VersionedFile } from "../api";

export type Language = "python" | "rust" | "cpp";

export type StepName = "understand" | "plan" | "code" | "test" | "review";

/** A solve goes through every step; a recall writes down the approach, then reviews it. */
export type Mode = "solve" | "recall";

export interface Session {
  mode: Mode;
  step: StepName;
  language: Language;
  prediction: string | null;
  plan: string;
  passed: boolean;
  runs: number;
  submissions: number;
  hints: number;
  started_at: number;
  updated_at: number;
}

export interface Case {
  input: string;
  output: string;
}

export interface OpenedLanguage {
  id: Language;
  name: string;
  editor_mode: string;
  code: VersionedFile;
  lsp: { root_uri: string; file_uri: string; language_id: string; options: unknown } | null;
}

export interface Opened {
  key: string;
  label: string;
  prompt: string;
  skills: string[];
  source: string | null;
  minutes: number;
  examples: Case[];
  hints: string[];
  languages: OpenedLanguage[];
  session: Session;
  previous_plan: string | null;
  solution: {
    approach: string;
    notes: string | null;
    reference: { language: Language; text: string }[];
  } | null;
}

export type Ending =
  | { status: "exited"; code: number | null }
  | { status: "timed_out" }
  | { status: "cancelled" };

export interface Run {
  ending: Ending;
  stdout: string;
  stderr: string;
  duration_ms: number;
}

export type CaseRef =
  | { kind: "example"; index: number }
  | { kind: "test"; index: number }
  | { kind: "random"; seed: number; size: number };

export interface CaseResult {
  case: CaseRef;
  input: string;
  expected: string;
  run: Run;
  passed: boolean;
}

export type Graded =
  | { outcome: "build_failed"; errors: string }
  | { outcome: "unavailable"; reason: string }
  | { outcome: "ran"; results: CaseResult[]; total: number };

export interface Submitted {
  passed: boolean;
  problem: string | null;
  failure: CaseResult | null;
  ran: number;
  total: number;
  opened: Opened;
}

export type Status = "in_progress" | "due" | "new" | "done" | "flagged";

export interface Listed {
  key: string;
  kind: "coding" | "reading";
  label: string;
  skills: string[];
  minutes: number;
  status: Status;
  step: StepName | null;
  mode: Mode | null;
}

export interface Overview {
  items: Listed[];
  week: { minutes: number; target: number };
}
