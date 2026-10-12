import { useEffect, useState } from "preact/hooks";
import { api, type Puzzle } from "../api";

/** The most recent year with puzzles: the current year from December, otherwise the last. */
export function latestYear(now = new Date()): number {
  return now.getMonth() === 11 ? now.getFullYear() : now.getFullYear() - 1;
}

/** Advent of Code has 12 days from 2025 onwards, and 25 before that. */
export function daysIn(year: number): number {
  return year >= 2025 ? 12 : 25;
}

interface Props {
  current: Puzzle | null;
  hasSession: boolean;
  onPick: (puzzle: Puzzle) => void;
}

/** Stars already fetched this session, so switching back to a year is instant. */
const starsByYear = new Map<number, Record<string, number>>();

export function Picker({ current, hasSession, onPick }: Props) {
  const [year, setYear] = useState(current?.year ?? latestYear());
  // Tagged with their year, so another year's stars are never shown while loading.
  const [loaded, setLoaded] = useState<{ year: number; stars: Record<string, number> } | null>(
    null,
  );
  const stars = loaded?.year === year ? loaded.stars : (starsByYear.get(year) ?? null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    setError(null);
    api
      .stars(year)
      .then((s) => {
        starsByYear.set(year, s);
        if (!cancelled) setLoaded({ year, stars: s });
      })
      .catch(
        (e: unknown) =>
          !cancelled &&
          setError(`Couldn't load your stars: ${e instanceof Error ? e.message : String(e)}`),
      );
    return () => {
      cancelled = true;
    };
  }, [year, hasSession]);

  const years: number[] = [];
  for (let y = latestYear(); y >= 2015; y--) years.push(y);
  const total = stars === null ? null : Object.values(stars).reduce((a, b) => a + b, 0);
  const status = !hasSession
    ? "Add your session cookie to see stars."
    : (error ?? (total === null ? "Loading stars…" : `${total} stars in ${year}`));

  return (
    <div class="picker">
      <div class="years">
        {years.map((y) => (
          <button
            type="button"
            key={y}
            class={`chip ${y === year ? "selected" : ""}`}
            onClick={() => setYear(y)}
          >
            {y}
          </button>
        ))}
      </div>
      <p class="muted">{status}</p>
      <div class={`days ${hasSession && stars === null ? "loading" : ""}`}>
        {Array.from({ length: daysIn(year) }, (_, i) => i + 1).map((day) => {
          const count = stars?.[String(day)] ?? 0;
          const isCurrent = current?.year === year && current.day === day;
          return (
            <button
              type="button"
              key={day}
              class={`day ${isCurrent ? "selected" : ""}`}
              onClick={() => onPick({ year, day })}
            >
              <span>{day}</span>
              <span class="stars">{"★".repeat(count)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
