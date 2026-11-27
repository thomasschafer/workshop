// Types mirror the mistake log in src/mistakes.rs and goals' progress in src/goals.rs.

export interface ErrorType {
  id: string;
  name: string;
  description: string;
}

export type MistakeSource = "answer" | "submission" | "grader";

export interface Mistake {
  id: string;
  /** `pack/item`. */
  item: string;
  /** In milliseconds since 1970. */
  at: number;
  source: MistakeSource;
  attempt: string | null;
  /** What went wrong, in words. */
  detail: string;
  /** The kind of mistake it looks like, if that could be told. */
  suggested: string | null;
  /** The kind the learner confirmed or chose. */
  confirmed: string | null;
  /** What the item is called, if it's still in the packs. */
  label: string | null;
  skills: string[];
}

export interface MistakeLog {
  error_types: ErrorType[];
  mistakes: Mistake[];
  common: { error_type: string; count: number }[];
  /** The skills recent mistakes point to, which practice leans towards. */
  focus: string[];
  /** Every skill's name, by id. */
  skills: Record<string, string>;
}

export interface SkillProgress {
  id: string;
  name: string;
  /** How well its taught items are recalled, from 0 to 1. */
  mastery: number;
  /** How much of it has been taught and then recalled, from 0 to 1. Missing from goals saved
   * on a device by an older Workshop, as are `topics` and `covered`. */
  coverage?: number;
  /** How many topics its outline has, or 0 for a skill without one. */
  topics?: number;
  /** How many of its topics are covered, or without topics, how many items were answered right. */
  covered?: number;
  items: number;
  attempted: number;
  /** Whether its coverage and recall have both reached the goal's targets. */
  met: boolean;
}

export interface GoalProgress {
  id: string;
  name: string;
  /** The pack it's from, by name. */
  pack: string;
  /** The recall each skill should reach. */
  target: number;
  /** The coverage each skill should reach. Missing from goals saved by an older Workshop. */
  coverage_target?: number;
  by: string | null;
  days_left: number | null;
  /** How far towards the target, from 0 to 1. */
  progress: number;
  skills: SkillProgress[];
  /** Average recall (`mastery`) and coverage each week, oldest first, ending now. Coverage is
   * missing from goals saved by an older Workshop. */
  trend: { at: number; mastery: number; coverage?: number }[];
  /** The skills furthest from the targets, by the lower of coverage and recall, weakest first. */
  weakest: string[];
  mistakes: { error_type: string; count: number }[];
}
