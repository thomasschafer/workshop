// Types mirror the Coding track in src/coding.rs and src/server/coding.rs, and the results of
// running code in crates/coding.

import type { InstallStatus, ProgramNeeds, VersionedFile } from "../api";
import type { MarkedReply } from "../grading/types";

export type Language = "python" | "rust" | "cpp" | "haskell";

export type StepName = "understand" | "plan" | "code" | "test" | "review" | "twist";

/**
 * A solve goes through every step; a twist, a review of a problem solved before, answers a
 * follow-up on it; and a recall, a review with no twist, writes down the approach, then
 * compares it with the problem's.
 */
export type Mode = "solve" | "recall" | "twist";

/** The sort of change a twist makes to the problem. */
export type TwistKind = "constraint" | "scale" | "streaming" | "complexity" | "edge_case";

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
  /** Why a review that would have been a twist is a recall instead. */
  no_twist: string | null;
  started_at: number;
  updated_at: number;
}

export interface Case {
  input: string;
  output: string;
}

/** Whether the Coding track has a language's programs, and installing them with mise. */
export interface Toolchain extends ProgramNeeds {
  name: string;
  mise_installed: boolean;
  /** Why the language's mise config couldn't be read, if it couldn't. */
  problem: string | null;
  install: InstallStatus;
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
  /** For a twist, the twist, once it's been posed. */
  twist: { kind: TwistKind; prompt: string } | null;
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

export type Status = "in_progress" | "due" | "new" | "done" | "flagged" | "retired";

/** How the grader marked an answer to a twist, which finished the review. */
export interface TwistMarked extends MarkedReply, Finished {
  /** What a good answer covers. */
  notes: string;
  /** How the original problem is solved. */
  approach: string;
}

/** How a problem stands once it's finished, or brought back. */
export interface Finished {
  /** When it comes back, unless it's retired. */
  due: number | null;
  /** Rated easy, so it never comes back, until it's brought back. */
  retired: boolean;
}

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
