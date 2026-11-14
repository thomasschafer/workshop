import { describe, expect, it } from "vitest";
import { pathOf, routeFor, routeOf } from "./routes";

describe("routeOf", () => {
  it("shows the home screen by default", () => {
    expect(routeOf("/", "")).toEqual({ screen: "home" });
    expect(routeOf("/nowhere", "")).toEqual({ screen: "home" });
  });

  it("shows Advent of Code at its own address", () => {
    expect(routeOf("/advent-of-code", "")).toEqual({ screen: "advent-of-code" });
    expect(routeOf("/advent-of-code", "?open=2026-4")).toEqual({ screen: "advent-of-code" });
    expect(routeOf("/advent-of-code-more", "")).toEqual({ screen: "home" });
  });

  it("practises a track at its own address", () => {
    expect(routeOf("/practice/review", "")).toEqual({ screen: "practice", track: "review" });
    expect(routeOf("/practice/pack%3Aestimation", "")).toEqual({
      screen: "practice",
      track: "pack:estimation",
    });
    expect(routeOf("/practice/", "")).toEqual({ screen: "home" });
    expect(routeOf("/practice/Not%20a%20track", "")).toEqual({ screen: "home" });
  });

  it("shows the mistake log, goals and packs at their own addresses", () => {
    expect(routeOf("/mistakes", "")).toEqual({ screen: "mistakes" });
    expect(routeOf("/goals/quick-arithmetic", "")).toEqual({
      screen: "goals",
      goal: "quick-arithmetic",
    });
    expect(routeOf("/goals/Not a goal", "")).toEqual({ screen: "goals", goal: null });
    expect(routeOf("/pack", "")).toEqual({ screen: "pack" });
  });

  it("opens Advent of Code for a puzzle a notification asked for at the home address", () => {
    expect(routeOf("/", "?open=2026-4")).toEqual({ screen: "advent-of-code" });
  });
});

describe("pathOf", () => {
  it("leads back to the same screen", () => {
    for (const route of [
      { screen: "home" },
      { screen: "advent-of-code" },
      { screen: "practice", track: "pack:estimation" },
      { screen: "coding", item: null },
      { screen: "coding", item: "sample/islands" },
      { screen: "mistakes" },
      { screen: "design", item: null },
      { screen: "design", item: "sample/link-shortener" },
      { screen: "goals", goal: null },
      { screen: "goals", goal: "quick-arithmetic" },
      { screen: "pack" },
    ] as const) {
      expect(routeOf(pathOf(route), "")).toEqual(route);
    }
  });
});

describe("routeFor", () => {
  it("finds Advent of Code's puzzles and list on its screen", () => {
    expect(routeFor({ kind: "puzzle", puzzle: { year: 2024, day: 3 } })).toEqual({
      screen: "advent-of-code",
    });
    expect(routeFor({ kind: "puzzle_list" })).toEqual({ screen: "advent-of-code" });
  });

  it("opens the Coding track's items on its screen", () => {
    expect(routeFor({ kind: "coding", item: "sample/islands" })).toEqual({
      screen: "coding",
      item: "sample/islands",
    });
    expect(routeOf("/coding/sample/islands", "")).toEqual({
      screen: "coding",
      item: "sample/islands",
    });
    // An address that isn't an item's shows the list.
    expect(routeOf("/coding/Sample/x/y", "")).toEqual({ screen: "coding", item: null });
  });

  it("practises a track on its own screen", () => {
    expect(routeFor({ kind: "practice", track: "mental-maths" })).toEqual({
      screen: "practice",
      track: "mental-maths",
    });
  });
});
