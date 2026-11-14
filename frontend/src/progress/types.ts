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
