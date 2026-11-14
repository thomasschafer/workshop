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
    | ({ kind: "reading"; language: "cpp" | "python" | "rust"; explanation: string } & (
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

export interface Deck {
  limits: Limits;
  /** `new_today` is missing from decks saved on a device by an older Workshop. */
  progress: { reviews_today: number; new_today?: number; minutes_this_week: number };
  /** When the learner's day and week began, as the deck was made. */
  day_start: number;
  week_start: number;
  /** A deck saved by an older version has no icons. */
  tracks: { id: TrackId; name: string; icon?: TrackIconName }[];
  items: DeckItem[];
  schedules: Record<string, ItemSchedule>;
  flags: Record<string, { at: number; note: string | null }>;
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
