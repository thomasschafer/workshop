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

  it("practises a track on its own screen", () => {
    expect(routeFor({ kind: "practice", track: "mental-maths" })).toEqual({
      screen: "practice",
      track: "mental-maths",
    });
  });
});
