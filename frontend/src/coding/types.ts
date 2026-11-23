// Types mirror the Coding track in src/coding.rs and src/server/coding.rs, and the results of
// running code in crates/coding.

import type { InstallStatus, ProgramNeeds, VersionedFile } from "../api";
import type { MarkedReply } from "../grading/types";
import type { TrackIcon as TrackIconName, TrackId } from "../tracks/types";

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
  /** For a problem in parts, the part they're on, counting from 0. */
  part: number;
  /** For a problem in parts, how they planned each part before the one they're on. */
  plans: string[];
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
  /** Monotonic version bumped on every write, shared by online and offline sync paths. */
  version?: number | undefined;
}

export interface OracleCase {
  seed: number;
  size: number;
  input: string;
  output: string;
}

export interface OfflineLanguage {
  id: Language;
  name: string;
  editor_mode: string;
  starter: string;
  code: VersionedFile | null;
  file_path: string;
  lsp: { root_uri: string; file_uri: string; language_id: string; options: unknown } | null;
}

export interface OfflineItem {
  key: string;
  label: string;
  track: OpenedTrack;
  skills: string[];
  source: string | null;
  minutes: number;
  /** Every part, shown only as far as the session has reached. */
  parts: OpenedPart[];
  api: Api | null;
  languages: OfflineLanguage[];
  session: Session | null;
  previous_plan: string | null;
  solution: {
    approach: string;
    notes: string | null;
    reference: { language: Language; text: string }[];
  };
  /** Each part's hidden tests. */
  tests: Case[][];
  oracle_cases: OracleCase[];
  oracle_ready: boolean;
}

export interface OfflineBundle {
  items: OfflineItem[];
  empty_version: string;
  oracles_computing: boolean;
}

/**
 * An input and what a right solution prints for it. In API mode, the input is the calls made,
 * a JSON array a line, and the output what each returns, a JSON value a line.
 */
export interface Case {
  input: string;
  output: string;
}

/** How the tests call the learner's code, in API mode. */
export interface Api {
  /** The class they make, or with none, the module's functions are called. */
  class: string | null;
}

/** One of a problem's parts, as far as the learner has reached. */
export interface OpenedPart {
  /** In Markdown: the item's prompt for the first part. */
  prompt: string;
  examples: Case[];
  /** The pack's hints for the part, from gentlest to most telling. */
  hints: string[];
  /** Earlier parts, counting from 0, whose requirements it changes. */
  replaces: number[];
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

/** The track a problem is in: the Coding track, or another, such as a pack's own. */
export interface OpenedTrack {
  id: TrackId;
  name: string;
  icon: TrackIconName;
}

export interface Opened {
  key: string;
  label: string;
  track: OpenedTrack;
  skills: string[];
  source: string | null;
  minutes: number;
  /** The parts the learner can see: those reached, or all of them once it's reviewed. */
  parts: OpenedPart[];
  /** How many parts it has, seen or not. */
  part_count: number;
  api: Api | null;
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
  /** The size output is cut off at, in bytes, if it printed more than that, so its output couldn't be compared. */
  cut_off: number | null;
  duration_ms: number;
}

/** Which case something ran on; `part` is only there for a problem in parts. */
export type CaseRef =
  | { kind: "example"; part?: number; index: number }
  | { kind: "test"; part?: number; index: number }
  | { kind: "random"; part?: number; seed: number; size: number };

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
