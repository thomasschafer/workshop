// Types mirror the deck in src/learning.rs and the log in crates/learning.

import type { TrackIcon as TrackIconName, TrackId } from "../tracks/types";

export type Rating = "again" | "hard" | "good" | "easy";

export interface ItemSchedule {
  stability: number;
  difficulty: number;
  stability_fast: number;
  /** When it was last attempted, in milliseconds since 1970. */
  last_review: number;
  reviews: number;
  lapses: number;
}

export interface Tolerance {
  absolute: number;
  /** As a fraction of the exact answer. */
  relative: number;
  /** For answers only the magnitude of matters: how many times off an answer may be. */
  factor?: number;
}

export interface Instance {
  seed: number;
  prompt: string;
  answer: number;
  method: string | null;
}

interface ItemBase {
  /** `pack/item`. */
  key: string;
  track: TrackId;
  label: string;
  skills: string[];
  /** In Markdown. */
  prompt: string;
  source: string | null;
  minutes: number;
}

export type DeckItem = ItemBase &
  (
    | { kind: "card"; answer: string; explanation: string | null }
    | { kind: "mental-maths"; instances: Instance[]; tolerance: Tolerance }
    | {
        kind: "probability";
        answer: number;
        answer_text: string;
        tolerance: Tolerance;
        solution: string;
      }
    | ({ kind: "reading"; language: "cpp" | "haskell" | "python" | "rust"; explanation: string } & (
        | { ask: "prints"; output: string }
        | { ask: "choice"; choices: string[]; answer: number }
      ))
  );

export interface Limits {
  daily_reviews: number;
  /** The most new items to start in a day. Decks saved on a device by an older Workshop don't
   * have it, and aren't limited until the next deck comes. */
  daily_new?: number;
  weekly_minutes: number;
  retention: number;
}

/** What's been done today and this week, as the server knows. */
export interface DeckProgress {
  reviews_today: number;
  /** Missing from decks saved on a device by an older Workshop. */
  new_today?: number;
  minutes_this_week: number;
}

export interface Deck {
  limits: Limits;
  /** What's been done today and this week, but in tracks kept apart. */
  progress: DeckProgress;
  /** When the learner's day and week began, as the deck was made. */
  day_start: number;
  week_start: number;
  /** A deck saved by an older version has no icons, and no tracks kept apart. */
  tracks: {
    id: TrackId;
    name: string;
    icon?: TrackIconName;
    /** Kept out of Continue, so its items have daily limits of their own, and don't count
     * towards the week's target. */
    kept_apart?: boolean;
    /** For a track kept apart, what's been done in it today and this week. */
    progress?: DeckProgress | null;
  }[];
  items: DeckItem[];
  schedules: Record<string, ItemSchedule>;
  flags: Record<string, { at: number; note: string | null }>;
  /** Where each item that's ever been retired stands. Decks saved on a device by an older
   * Workshop don't have it. */
  retirements?: Record<string, Retirement>;
  skills: { id: string; name: string; mastery: number; items: number; attempted: number }[];
  /** The skills recent mistakes point to, whose new items come first. Decks saved on a device
   * by an older Workshop don't have it. */
  focus?: string[];
  problems: string[];
}

export interface Attempt {
  id: string;
  item: string;
  answered_at: number;
  duration_ms: number;
  rating: Rating;
  response?: string;
  seed?: number;
}

export interface FlagChange {
  id: string;
  item: string;
  at: number;
  flagged: boolean;
  note?: string;
}

/** Where a retired item stands: still retired, or brought back, which makes it due from then. */
export interface Retirement {
  state: "retired" | "brought_back";
  at: number;
}

/**
 * Retiring an item, so it's never offered again, or bringing it back. Retiring one with a fixed
 * answer has the id of the attempt, rated easy, that retired it.
 */
export interface RetirementChange {
  id: string;
  item: string;
  at: number;
  retired: boolean;
}
