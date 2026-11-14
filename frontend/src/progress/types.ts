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
  /** From 0 to 1. */
  mastery: number;
  items: number;
  attempted: number;
  /** Whether it's reached the goal's target. */
  met: boolean;
}

export interface GoalProgress {
  id: string;
  name: string;
  /** The pack it's from, by name. */
  pack: string;
  target: number;
  by: string | null;
  days_left: number | null;
  /** How far towards the target, from 0 to 1. */
  progress: number;
  skills: SkillProgress[];
  /** Average mastery each week, oldest first, ending now. */
  trend: { at: number; mastery: number }[];
  /** The skills furthest from the target, weakest first. */
  weakest: string[];
  mistakes: { error_type: string; count: number }[];
}
