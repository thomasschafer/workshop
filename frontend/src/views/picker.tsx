import { useEffect, useState } from "preact/hooks";
import { api, type LeaderboardMember, type Puzzle, type StarTimes } from "../api";
import {
  daysIn,
  formatCountdown,
  formatStarTime,
  isUnlocked,
  latestYear,
  nextUnlock,
  todaysPuzzle,
} from "../calendar";
import { useNow } from "../hooks/useNow";
import { isPractice, PRACTICE } from "../puzzle";

interface Props {
  current: Puzzle | null;
  hasSession: boolean;
  onPick: (puzzle: Puzzle) => void;
}

/** Stars already fetched this session, so switching back to a year is instant. */
const starsByYear = new Map<number, Record<string, number>>();

export function Picker({ current, hasSession, onPick }: Props) {
  // During the event, its year, as today's puzzle is the one most likely wanted; otherwise the
  // year of the puzzle that's open.
  const [year, setYear] = useState(
    () => todaysPuzzle()?.year ?? (current && !isPractice(current) ? current.year : latestYear()),
  );
  // Tagged with their year, so another year's stars are never shown while loading.
  const [loaded, setLoaded] = useState<{ year: number; stars: Record<string, number> } | null>(
    null,
  );
  const stars = loaded?.year === year ? loaded.stars : (starsByYear.get(year) ?? null);
  const [error, setError] = useState<string | null>(null);
  const [times, setTimes] = useState<{ year: number; times: Record<string, StarTimes> } | null>(
    null,
  );
  // A second at a time while counting down, so the next day opens the moment it unlocks.
  const upcoming = nextUnlock();
  const now = useNow(1000, upcoming !== null);
  const next = nextUnlock(now);
  const today = todaysPuzzle(now);

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

  // Times are extra: without them the picker works just the same, so failing is quiet.
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    api
      .times(year)
      .then((t) => !cancelled && setTimes({ year, times: t }))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [year, hasSession]);
  const yearTimes = times?.year === year ? Object.entries(times.times) : [];

  // Only when one's chosen: the server says so by returning nothing.
  const [board, setBoard] = useState<{ year: number; members: LeaderboardMember[] } | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    setBoardError(null);
    api
      .leaderboard(year)
      .then((members) => !cancelled && setBoard(members ? { year, members } : null))
      .catch(
        (e: unknown) =>
          !cancelled &&
          setBoardError(
            `Couldn't load the leaderboard: ${e instanceof Error ? e.message : String(e)}`,
          ),
      );
    return () => {
      cancelled = true;
    };
  }, [year, hasSession]);
  const members = board?.year === year ? board.members : null;

  const years: number[] = [];
  for (let y = latestYear(now); y >= 2015; y--) years.push(y);
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
      {next && next.puzzle.year === year ? (
        <p class="countdown">
          Day {next.puzzle.day} unlocks in <strong>{formatCountdown(next.at - now)}</strong>
        </p>
      ) : null}
      <div class={`days ${hasSession && stars === null ? "loading" : ""}`}>
        {Array.from({ length: daysIn(year) }, (_, i) => i + 1).map((day) => {
          const count = stars?.[String(day)] ?? 0;
          const isCurrent = current?.year === year && current.day === day;
          const locked = !isUnlocked(year, day, now);
          const isToday = today?.year === year && today.day === day;
          return (
            <button
              type="button"
              key={day}
              class={`day ${isCurrent ? "selected" : ""} ${locked ? "locked" : ""} ${isToday ? "today" : ""}`}
              disabled={locked}
              aria-label={locked ? `Day ${day}, not unlocked yet` : undefined}
              onClick={() => onPick({ year, day })}
            >
              <span>{day}</span>
              <span class="stars">{"★".repeat(count)}</span>
            </button>
          );
        })}
      </div>
      {yearTimes.length > 0 ? (
        <table class="star-times">
          <caption>Your time to each star</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Part 1</th>
              <th scope="col">Part 2</th>
            </tr>
          </thead>
          <tbody>
            {yearTimes.map(([day, [first, second]]) => (
              <tr key={day}>
                <th scope="row">{day}</th>
                <td>{first ? formatStarTime(first) : "–"}</td>
                <td>{second ? formatStarTime(second) : "–"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {members && members.length > 0 ? (
        <table class="star-times">
          <caption>Leaderboard</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Stars</th>
              <th scope="col">Score</th>
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.name}>
                <th scope="row">{m.name}</th>
                <td>{m.stars}</td>
                <td>{m.score}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
      {boardError ? <p class="muted small">{boardError}</p> : null}
      <div class="practice">
        <button
          type="button"
          class={`chip ${current && isPractice(current) ? "selected" : ""}`}
          onClick={() => onPick(PRACTICE)}
        >
          Practice puzzle
        </button>
      </div>
    </div>
  );
}
