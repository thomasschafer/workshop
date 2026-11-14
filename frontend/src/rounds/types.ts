// Types mirror timed rounds in crates/sessions/src/round.rs, and their routes in
// src/server/rounds.rs.

import type { Marked, SessionTurn } from "../grading/types";
import type { Priority } from "../tracks/types";

/** What a round can be made of. */
export type RoundKind = "coding" | "probability" | "design";

export type Ending = "time_up" | "finished" | "interrupted";

export interface Clock {
  used_ms: number;
  remaining_ms: number;
}

export interface Style {
  id: string;
  name: string;
  description: string;
}

export interface Listed {
  key: string;
  label: string;
  kind: RoundKind;
  /** How long a round of it lasts. */
  minutes: number;
  /** For a round under way, how much of the clock is left, and how it ended if it has. */
  remaining_ms: number | null;
  ended: Ending | null;
}

export interface Overview {
  /** What Continue would start a round of, and why. */
  suggested: { key: string; reason: string; priority: Priority } | null;
  under_way: Listed[];
  items: Listed[];
}

export interface Round {
  style: Style | null;
  clock: Clock;
  work: string;
  turns: SessionTurn[];
  /** Whether the learner has come back after a gap, which the clock didn't count. */
  returned: boolean;
  ended: Ending | null;
}

export interface Opened {
  key: string;
  label: string;
  kind: RoundKind;
  /** In Markdown. */
  prompt: string;
  source: string | null;
  /** A coding problem's examples. */
  examples: { input: string; output: string }[];
  minutes: number;
  /** The styles the examiner can take, from the item's pack. */
  styles: Style[];
  round: Round | null;
}

export interface Beat {
  clock: Clock;
  ended: Ending | null;
}

export interface Ended {
  ending: Ending;
  marked: Marked;
  rubric: string[];
  /** When the item comes back, if the round counted as an attempt. */
  due: number | null;
}
