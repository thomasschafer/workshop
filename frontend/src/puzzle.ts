import type { Puzzle } from "./api";

/** The invented puzzle to practise on, which needs no Advent of Code account. */
export const PRACTICE: Puzzle = { year: 0, day: 1 };

export function isPractice(p: Puzzle): boolean {
  return p.year === PRACTICE.year && p.day === PRACTICE.day;
}

/** How a puzzle is named in the app, such as "2017 · day 4". */
export function puzzleLabel(p: Puzzle): string {
  return isPractice(p) ? "Practice puzzle" : `${p.year} · day ${p.day}`;
}

/** How a puzzle is named in a commit message. */
export function puzzleTitle(p: Puzzle): string {
  return isPractice(p) ? "Workshop practice puzzle" : `Advent of Code ${p.year} day ${p.day}`;
}
