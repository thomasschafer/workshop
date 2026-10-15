import type { Puzzle } from "./api";

/**
 * When a puzzle unlocks: midnight US Eastern time, which in December is always 05:00 UTC, as
 * daylight saving has ended by then.
 */
export function unlockTime(year: number, day: number): number {
  return Date.UTC(year, 11, day, 5);
}

/** Advent of Code has 12 days from 2025 onwards, and 25 before that. */
export function daysIn(year: number): number {
  return year >= 2025 ? 12 : 25;
}

/** The most recent year with puzzles: this year once its first puzzle unlocks, else the last. */
export function latestYear(now = Date.now()): number {
  const year = new Date(now).getUTCFullYear();
  return now >= unlockTime(year, 1) ? year : year - 1;
}

export function isUnlocked(year: number, day: number, now = Date.now()): boolean {
  return now >= unlockTime(year, day);
}

/** The puzzle that unlocked most recently, while the event is running: today's puzzle. */
export function todaysPuzzle(now = Date.now()): Puzzle | null {
  const year = latestYear(now);
  const day = Math.floor((now - unlockTime(year, 1)) / DAY_MS) + 1;
  return day >= 1 && day <= daysIn(year) ? { year, day } : null;
}

/**
 * The next puzzle to unlock, and when, if one is coming up: the next day of the event, or its
 * first day from the start of November.
 */
export function nextUnlock(now = Date.now()): { puzzle: Puzzle; at: number } | null {
  const today = todaysPuzzle(now);
  if (today) {
    if (today.day >= daysIn(today.year)) return null;
    const puzzle = { year: today.year, day: today.day + 1 };
    return { puzzle, at: unlockTime(puzzle.year, puzzle.day) };
  }
  const year = new Date(now).getUTCFullYear();
  const at = unlockTime(year, 1);
  return now < at && now >= Date.UTC(year, 10, 1) ? { puzzle: { year, day: 1 }, at } : null;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** How long until something, as briefly as is still useful: "3d 4h", "2h 14m" or "4m 05s". */
export function formatCountdown(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  return `${minutes}m ${String(secs).padStart(2, "0")}s`;
}

/** A time to a star as Advent of Code gives it, without leading zeros: "01:03:06" is "1:03:06". */
export function formatStarTime(time: string): string {
  if (!time.includes(":")) return time;
  const trimmed = time.replace(/^(00:)+/, "").replace(/^0(\d)/, "$1");
  return trimmed;
}
