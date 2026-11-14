import type { Destination, TrackId } from "./types";

/** The screens the app's address can lead to. */
export type Route =
  | { screen: "home" }
  | { screen: "advent-of-code" }
  | { screen: "practice"; track: TrackId };

const HOME_PATH = "/";
const ADVENT_OF_CODE_PATH = "/advent-of-code";
const PRACTICE_PATH = "/practice/";

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
  }
}
