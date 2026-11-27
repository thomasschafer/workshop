// Types mirror the packs' routes in src/server/packs.rs.

export interface Draft {
  id: string;
  path: string;
  source: string | null;
  skills: string[];
  kind: string | null;
  added: string | null;
  text: string;
}

export interface PackShown {
  id: string;
  name: string;
  /** Whether it can be changed: the sample pack is built in. */
  editable: boolean;
  skills: { id: string; name: string }[];
  drafts: Draft[];
}

export interface Turn {
  who: "writer" | "reviewer";
  text: string;
}

export interface Linked {
  path: string;
  id: string;
  label: string;
  lesson: string;
  segment: number | null;
  content: string;
}

export interface Written {
  path: string;
  id: string;
  label: string;
  skills: string[];
  /** Its files, by path in the pack. */
  files: Record<string, string>;
  from_draft: string | null;
  transcript: Turn[];
  reason: string | null;
  /** For a queued lesson, its accompanying items held with it until it's approved. */
  items?: Written[];
  /** For a queued lesson, existing items to link to it when it's approved. */
  linked?: Linked[];
}

export interface Report {
  accepted: Written[];
  /** Existing items linked to accepted lessons written in this run. */
  linked?: Linked[];
  queued: Written[];
  dropped: Written[];
  questions: string[];
  put_back: string[];
}

export interface WaitingLessonRequest {
  item: string;
  label: string;
  skills: string[];
  requested_at: number;
}

export interface AuthorStatus {
  running: boolean;
  /** When the server runs the author by itself, if it's scheduled to. */
  schedule: {
    /** Such as "every 7 days". */
    every: string;
    /** The time of day it waits for, such as "02:00", on the server's clock. */
    after: string | null;
    /** When the next run is due, in milliseconds since 1970. */
    next_at: number;
  } | null;
  /** Why the author can't run, if it can't. */
  unavailable: string | null;
  writer: string;
  reviewer: string;
  /** Why the reviewer is the one it is, such as there being no other provider to use. */
  reviewer_reason: string;
  /** Whether the reviewer uses the writer's own provider. */
  reviewer_shares_provider: boolean;
  max_items: number;
  last: {
    started_at: number;
    finished_at: number;
    report: Report | null;
    commit: string | null;
    error: string | null;
  } | null;
  queue: { id: string; pack: string; at: number; item: Written }[];
  questions: { id: string; text: string; asked_at: number; answer: string | null }[];
  lesson_requests?: WaitingLessonRequest[];
}
