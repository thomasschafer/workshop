// Types mirror the track model in crates/tracks, where steps lead in src/tracks.rs, and the home
// screen in src/server/home.rs.

import type { Puzzle } from "../api";

export type BuiltInTrackId =
  | "advent-of-code"
  | "coding"
  | "probability"
  | "system-design"
  | "mental-maths"
  | "review";

/** A built-in track, or one a pack defines, as `pack:` and its ID within the pack. */
export type TrackId = BuiltInTrackId | `pack:${string}`;

/** How soon a step should be done: what Continue goes by. */
export type Priority = "due" | "unfinished" | "focus" | "new" | "browse";

/** Where a step or a track leads in the app. */
export type Destination =
  | { kind: "puzzle"; puzzle: Puzzle }
  | { kind: "puzzle_list" }
  | { kind: "practice"; track: TrackId }
  /** The Coding track: one of its items, as `pack/item`, or the list of them. */
  | { kind: "coding"; item: string | null }
  /** Design prompts: one of them, as `pack/item`, or the list of them. */
  | { kind: "design"; item: string | null };

export interface Step {
  title: string;
  /** Why it's suggested, such as "Where you left off". */
  reason: string;
  priority: Priority;
  destination: Destination;
}

export interface Track {
  id: TrackId;
  name: string;
  /** A line about where the learner is in it. */
  summary: string;
  /** Where opening the track leads. */
  destination: Destination;
  next: Step | null;
}

export interface Home {
  /** The step Continue takes, if any track suggests one. */
  continue: (Step & { track: TrackId }) | null;
  /** The tracks with something in them, in the order they're shown. */
  tracks: Track[];
  /** Minutes of practice this week, towards the week's target, unless the packs can't be read. */
  week: { minutes: number; target: number } | null;
  /** What's wrong with the packs, such as items that couldn't be read. */
  problems: string[];
}
