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

export function Picker({ current, hasSession, onPick }: Props) {
  const [year, setYear] = useState(current?.year ?? latestYear());
  const [stars, setStars] = useState<Record<string, number>>({});
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    setStars({});
    setError(null);
    api
      .stars(year)
      .then((s) => !cancelled && setStars(s))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [year, hasSession]);

  const years: number[] = [];
  for (let y = latestYear(); y >= 2015; y--) years.push(y);
  const total = Object.values(stars).reduce((a, b) => a + b, 0);

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
      <p class="muted">
        {hasSession
          ? (error ?? `${total} stars in ${year}`)
          : "Add your session cookie to see stars."}
      </p>
      <div class="days">
        {Array.from({ length: daysIn(year) }, (_, i) => i + 1).map((day) => {
          const count = stars[String(day)] ?? 0;
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
