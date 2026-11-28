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
  /** Full `pack/lesson` key of the lesson that teaches this item, if any. */
  lesson?: string | null;
  /** The segment of that lesson covering this item, counting from 0, if specified. */
  segment?: number | null;
}

export type DeckItem = ItemBase &
  (
    | {
        kind: "card";
        answer: string;
        explanation: string | null;
        /** How many follow-up questions the tutor asks when the learner goes deeper; 0 if the
         * card doesn't offer them. Decks saved on a device by an older Workshop don't have it,
         * and offer them, leaving the server to say how many. */
        follow_ups?: number;
      }
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

export interface DeckLessonSource {
  title: string;
  url: string;
}

export interface DeckLessonGuess {
  prompt: string;
  choices: string[];
  /** The right choice, counting from 0. */
  answer: number;
}

export interface DeckLessonCheck {
  prompt: string;
  choices: string[];
  /** The right choice, counting from 0. */
  answer: number;
  explanation: string;
}

export interface DeckLessonSegment {
  title: string;
  body: string;
  check: DeckLessonCheck | null;
}

export type DeckLessonImage = { kind: "svg"; svg: string } | { kind: "png"; data_url: string };

export interface DeckLesson {
  /** `pack/item`. */
  key: string;
  track: TrackId;
  title: string;
  skills: string[];
  /** What the lesson covers, in Markdown. */
  prompt: string;
  source: string | null;
  minutes: number;
  /** Full `pack/item` keys of lessons in the same pack to do first. */
  requires: string[];
  sources: DeckLessonSource[];
  guesses: DeckLessonGuess[];
  segments: DeckLessonSegment[];
  explain: string;
  explain_answer: string;
  /** Images referenced in segments, keyed by their relative path inside the lesson's directory. */
  images: Record<string, DeckLessonImage>;
}

export interface LessonCompletion {
  id: string;
  lesson: string;
  completed_at: number;
  /** How long the lesson took, in milliseconds. */
  duration_ms?: number;
}

export interface LessonSkip {
  id: string;
  lesson: string;
  skipped_at: number;
}

export interface LessonRequest {
  id: string;
  item: string;
  requested_at: number;
}

export interface Limits {
  daily_reviews: number;
  /** The most new items to start in a day. Decks saved on a device by an older Workshop don't
   * have it, and aren't limited until the next deck comes. */
  daily_new?: number;
  /** The most lessons offered in practice in a day. Defaults to 1 when missing from older decks. */
  daily_lessons?: number;
  weekly_minutes: number;
  retention: number;
}

/** What's been done today and this week, as the server knows. */
export interface DeckProgress {
  reviews_today: number;
  /** Missing from decks saved on a device by an older Workshop. */
  new_today?: number;
  /** Distinct lessons completed today. Missing from decks saved by an older Workshop. */
  lessons_today?: number;
  minutes_this_week: number;
}

/** A lab, as its track lists it. Mirrors `DeckLab` in src/learning.rs. */
export interface DeckLab {
  key: string;
  track: TrackId;
  title: string;
  minutes: number;
  /** The `pack/lesson` key of the lesson to do first, if it names one. */
  lesson: string | null;
  /** Whether it's been done, and marked, at least once. */
  done: boolean;
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
  /** Lessons in the packs, with their embedded images. Missing from decks saved by an older Workshop. */
  lessons?: DeckLesson[];
  /** Labs in the packs, to list in their tracks; working through one needs the server. Missing
   * from decks saved by an older Workshop. */
  labs?: DeckLab[];
  schedules: Record<string, ItemSchedule>;
  flags: Record<string, { at: number; note: string | null }>;
  /** Where each item that's ever been retired stands. Decks saved on a device by an older
   * Workshop don't have it. */
  retirements?: Record<string, Retirement>;
  /** Completion timestamps (ms since 1970) per lesson key. Missing from decks saved by an older
   * Workshop. */
  lesson_completions?: Record<string, number[]>;
  /** Skip ("Not now") timestamps (ms since 1970) per lesson key. Missing from older decks. */
  lesson_skips?: Record<string, number[]>;
  /** Most recent attempt's rating per short item key. Missing from older decks. */
  last_ratings?: Record<string, Rating>;
  /** Each skill's recall (`mastery`) and coverage, as on the Goals page; coverage, `topics` and
   * `covered` are missing from decks saved by an older Workshop. */
  skills: {
    id: string;
    name: string;
    mastery: number;
    coverage?: number;
    topics?: number;
    covered?: number;
    items: number;
    attempted: number;
  }[];
  /** The skills recent mistakes point to, whose new items come first. Decks saved on a device
   * by an older Workshop don't have it. */
  focus?: string[];
  /** Cards with follow-up questions under way, which come first, to carry on with. Decks saved
   * on a device by an older Workshop don't have it. */
  follow_ups?: string[];
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
