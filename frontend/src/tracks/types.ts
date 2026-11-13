// Types mirror the track model in crates/tracks, and where steps lead in src/tracks.rs.

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
export type Priority = "due" | "unfinished" | "new" | "browse";

/** Where a step or a track leads in the app. */
export type Destination = { kind: "puzzle"; puzzle: Puzzle } | { kind: "puzzle_list" };

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
}
