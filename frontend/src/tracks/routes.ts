import type { Destination, TrackId } from "./types";

/** The screens the app's address can lead to. */
export type Route =
  | { screen: "home" }
  | { screen: "advent-of-code" }
  | { screen: "practice"; track: TrackId }
  | { screen: "lesson"; item: string }
  | { screen: "coding"; item: string | null }
  | { screen: "design"; item: string | null }
  | { screen: "rounds"; item: string | null }
  | { screen: "mistakes" }
  /** Progress towards a goal of the packs', by its id, or the list of goals. */
  | { screen: "goals"; goal: string | null }
  /** The packs: topping them up, items waiting for approval, importing and flagged items. */
  | { screen: "pack" };

const HOME_PATH = "/";
const ADVENT_OF_CODE_PATH = "/advent-of-code";
const PRACTICE_PATH = "/practice/";
const LESSONS_PATH = "/lessons";
const CODING_PATH = "/coding";
const DESIGN_PATH = "/design";
const ROUNDS_PATH = "/rounds";
const MISTAKES_PATH = "/mistakes";
const GOALS_PATH = "/goals";
const PACK_PATH = "/pack";
const SLUG = /^[a-z0-9-]+$/;

/**
 * The screen an address shows. A notification about a puzzle used to lead to the home address
 * with `?open=`, which still opens Advent of Code, as one may be tapped long after it arrived.
 */
export function routeOf(pathname: string, search: string): Route {
  if (pathname === ADVENT_OF_CODE_PATH || pathname.startsWith(`${ADVENT_OF_CODE_PATH}/`)) {
    return { screen: "advent-of-code" };
  }
  if (pathname.startsWith(PRACTICE_PATH)) {
    const track = decodeURIComponent(pathname.slice(PRACTICE_PATH.length));
    // Which tracks exist is the server's to say: a track that isn't one shows as having nothing.
    if (/^[a-z0-9-]+$|^pack:[a-z0-9-]+$/.test(track)) {
      return { screen: "practice", track: track as TrackId };
    }
  }
  if (pathname.startsWith(`${LESSONS_PATH}/`)) {
    const [pack, item, ...rest] = pathname.slice(LESSONS_PATH.length + 1).split("/");
    if (pack && item && rest.length === 0 && SLUG.test(pack) && SLUG.test(item)) {
      return { screen: "lesson", item: `${pack}/${item}` };
    }
  }
  for (const [base, screen] of [
    [CODING_PATH, "coding"],
    [DESIGN_PATH, "design"],
    [ROUNDS_PATH, "rounds"],
  ] as const) {
    if (pathname === base) return { screen, item: null };
    if (pathname.startsWith(`${base}/`)) {
      const [pack, item, ...rest] = pathname.slice(base.length + 1).split("/");
      if (pack && item && rest.length === 0 && SLUG.test(pack) && SLUG.test(item)) {
        return { screen, item: `${pack}/${item}` };
      }
      return { screen, item: null };
    }
  }
  if (pathname === MISTAKES_PATH) return { screen: "mistakes" };
  if (pathname === PACK_PATH) return { screen: "pack" };
  if (pathname === GOALS_PATH) return { screen: "goals", goal: null };
  if (pathname.startsWith(`${GOALS_PATH}/`)) {
    const goal = pathname.slice(GOALS_PATH.length + 1);
    return { screen: "goals", goal: SLUG.test(goal) ? goal : null };
  }
  if (new URLSearchParams(search).has("open")) return { screen: "advent-of-code" };
  return { screen: "home" };
}

export function pathOf(route: Route): string {
  switch (route.screen) {
    case "home":
      return HOME_PATH;
    case "advent-of-code":
      return ADVENT_OF_CODE_PATH;
    case "practice":
      return `${PRACTICE_PATH}${encodeURIComponent(route.track)}`;
    case "lesson":
      return `${LESSONS_PATH}/${route.item}`;
    case "coding":
      return route.item === null ? CODING_PATH : `${CODING_PATH}/${route.item}`;
    case "design":
      return route.item === null ? DESIGN_PATH : `${DESIGN_PATH}/${route.item}`;
    case "rounds":
      return route.item === null ? ROUNDS_PATH : `${ROUNDS_PATH}/${route.item}`;
    case "mistakes":
      return MISTAKES_PATH;
    case "goals":
      return route.goal === null ? GOALS_PATH : `${GOALS_PATH}/${route.goal}`;
    case "pack":
      return PACK_PATH;
  }
}

/** The screen a step or a track's destination is on. */
export function routeFor(destination: Destination): Route {
  switch (destination.kind) {
    case "puzzle":
    case "puzzle_list":
      return { screen: "advent-of-code" };
    case "practice":
      return { screen: "practice", track: destination.track };
    case "coding":
      return { screen: "coding", item: destination.item };
    case "design":
      return { screen: "design", item: destination.item };
    case "round":
      return { screen: "rounds", item: destination.item };
  }
}
