// Types mirror the grader in src/grader.rs and its routes in src/server/grading.rs.

export type Work = "design" | "plan" | "card" | "explanation";

export interface Marked {
  /** From 0 to 1. */
  score: number;
  points: { point: string; met: "yes" | "partly" | "no"; comment: string }[];
  findings: { error_type: string | null; detail: string }[];
  feedback: string;
  /** For work explained aloud, how clearly it was put. */
  clarity: { score: number; feedback: string } | null;
  /**
   * For a design whose questions were answered from a brief, the key requirements the learner
   * found out, those they missed, and what they assumed without asking.
   */
  questioning: { found: string[]; missed: string[]; assumed: string[] } | null;
}

export interface MarkedReply {
  marked: Marked;
  rubric: string[];
  /** When it comes back, for work that counts as an attempt. */
  due: number | null;
}

/** A design session marked, with the brief its questions were answered from, now it's shown. */
export interface DesignMarked extends MarkedReply {
  brief: string | null;
}

// Design sessions mirror crates/sessions/src/design.rs, and their routes src/server/design.rs.

export type Stage = "requirements" | "scale" | "outline" | "deep_dive" | "trade_offs";

export interface DesignListed {
  key: string;
  label: string;
  skills: string[];
  minutes: number;
  status: "in_progress" | "due" | "new" | "done";
  /** The stage it's at, if it's in progress. */
  stage: Stage | null;
  last_score: number | null;
}

export interface Component {
  name: string;
  /** What it does. */
  role: string;
  /** The components it talks to, by name. */
  talks_to: string[];
}

export interface SessionTurn {
  speaker: "learner" | "coach";
  text: string;
  at: number;
}

export interface DesignSession {
  stage: Stage;
  /** The furthest stage reached, which any stage up to can be gone back to. */
  reached: Stage;
  work: Partial<Record<Stage, { notes: string; turns: SessionTurn[] }>>;
  components: Component[];
  deep_dive: string | null;
  started_at: number;
  updated_at: number;
}

/** The learner's own changes to a session. */
export interface DesignEdit {
  stage: Stage;
  notes: Partial<Record<Stage, string>>;
  components: Component[];
  deep_dive: string | null;
}

export interface DesignOpened {
  key: string;
  label: string;
  prompt: string;
  skills: string[];
  minutes: number;
  source: string | null;
  /** At the stages where `learner_asks`, the learner asks the coach; at the others, it asks. */
  stages: { id: Stage; name: string; task: string; learner_asks: boolean }[];
  session: DesignSession | null;
  /** What was done last time, if it's been done before. */
  previous: string | null;
}

// A card's follow-up questions mirror src/follow_ups.rs, and their routes
// src/server/follow_ups.rs.

/** Something the learner said: their answer to the card, or a reply to a question. */
export interface Said {
  text: string;
  /** Whether it was explained aloud, so it's marked for clarity too. */
  spoken: boolean;
  at: number;
}

export interface FollowUpQuestion {
  text: string;
  asked_at: number;
  reply: Said | null;
}

/** A card answered in the learner's own words, and being followed up by the tutor. */
export interface Exchange {
  /** The most questions the tutor asks. */
  limit: number;
  answer: Said;
  questions: FollowUpQuestion[];
  started_at: number;
  updated_at: number;
  /** Whether the tutor asks next, the learner replies, or every question's been answered. */
  next: "ask" | "reply" | "mark";
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
