// Types mirror the grader in src/grader.rs and its routes in src/server/grading.rs.

export type Work = "design" | "plan" | "card";

export interface Marked {
  /** From 0 to 1. */
  score: number;
  points: { point: string; met: "yes" | "partly" | "no"; comment: string }[];
  findings: { error_type: string | null; detail: string }[];
  feedback: string;
}

export interface MarkedReply {
  marked: Marked;
  rubric: string[];
  /** When it comes back, for work that counts as an attempt. */
  due: number | null;
}

export interface DesignListed {
  key: string;
  label: string;
  skills: string[];
  minutes: number;
  status: "due" | "new" | "done";
  last_score: number | null;
}

export interface DesignOpened {
  key: string;
  label: string;
  prompt: string;
  skills: string[];
  minutes: number;
  source: string | null;
  previous: string | null;
}

export interface Review {
  verdict: "correct" | "wrong";
  explanation: string;
  fix: { answer: string; explanation: string | null } | null;
}

export interface FlaggedCard {
  key: string;
  label: string;
  prompt: string;
  answer: string;
  explanation: string | null;
  note: string | null;
  at: number;
  proposed: { review: Review; at: number } | null;
}
