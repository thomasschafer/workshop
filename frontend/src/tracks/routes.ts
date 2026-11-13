import type { Destination } from "./types";

/** The screens the app's address can lead to. */
export type Route = { screen: "home" } | { screen: "advent-of-code" };

const HOME_PATH = "/";
const ADVENT_OF_CODE_PATH = "/advent-of-code";

/**
 * The screen an address shows. A notification about a puzzle used to lead to the home address
 * with `?open=`, which still opens Advent of Code, as one may be tapped long after it arrived.
 */
export function routeOf(pathname: string, search: string): Route {
  if (pathname === ADVENT_OF_CODE_PATH || pathname.startsWith(`${ADVENT_OF_CODE_PATH}/`)) {
    return { screen: "advent-of-code" };
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
  }
}

/** The screen a step or a track's destination is on. */
export function routeFor(destination: Destination): Route {
  switch (destination.kind) {
    case "puzzle":
    case "puzzle_list":
      return { screen: "advent-of-code" };
  }
}
