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
}

export interface Report {
  accepted: Written[];
  queued: Written[];
  dropped: Written[];
  questions: string[];
  put_back: string[];
}

export interface AuthorStatus {
  running: boolean;
  /** Why the author can't run, if it can't. */
  unavailable: string | null;
  writer: string;
  reviewer: string;
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
}
