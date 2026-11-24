import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import {
  api,
  isTransientNetworkError,
  type LeaderboardMember,
  type Puzzle,
  type StarTimes,
} from "../api";
import {
  daysIn,
  formatCountdown,
  formatStarTime,
  isUnlocked,
  latestYear,
  nextUnlock,
  todaysPuzzle,
} from "../calendar";
import { errorMessage } from "../errors";
import { useConnection } from "../hooks/useConnection";
import { useNow } from "../hooks/useNow";
import { getAocYear, listAocPuzzles, mergeAocYear } from "../offline/db";
import { yearSync } from "../offline/yearSync";
import { isPractice, PRACTICE } from "../puzzle";
import { Modal } from "./modal";

interface Props {
  current: Puzzle | null;
  hasSession: boolean;
  onPick: (puzzle: Puzzle) => void;
}

/** Stars already fetched this session, so switching back to a year is instant. */
const starsByYear = new Map<number, Record<string, number>>();

/** How long a year chip must be held to open its offline sheet directly. */
const LONG_PRESS_MS = 450;

/** Pointer drift beyond this cancels a long-press so scrolling the year bar still feels natural. */
const LONG_PRESS_DRIFT_PX = 10;

interface CachedDayInfo {
  parts: number;
  hasInput: boolean;
  fullyCached: boolean;
}

function unlockedDaysFor(targetYear: number, now: number): number[] {
  const days: number[] = [];
  for (let d = 1; d <= daysIn(targetYear); d++) {
    if (isUnlocked(targetYear, d, now)) days.push(d);
  }
  return days;
}

/** Orders uncached days with unsolved ones first when star counts are known. */
function remainingDaysFor(
  targetYear: number,
  now: number,
  cached: ReadonlyMap<number, CachedDayInfo>,
  stars: Record<string, number> | null,
): number[] {
  const missing = unlockedDaysFor(targetYear, now).filter((d) => !cached.get(d)?.fullyCached);
  if (!stars) return missing;
  const unsolved = missing.filter((d) => (stars[String(d)] ?? 0) < 2);
  const solved = missing.filter((d) => (stars[String(d)] ?? 0) >= 2);
  return [...unsolved, ...solved];
}

export function Picker({ current, hasSession, onPick }: Props) {
  const online = useConnection();
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
  const [cachedByYear, setCachedByYear] = useState<Map<number, Map<number, CachedDayInfo>>>(
    () => new Map(),
  );
  const [, setSyncTick] = useState(0);
  /** Year whose offline bottom sheet is open, or null when closed. */
  const [offlineSheetYear, setOfflineSheetYear] = useState<number | null>(null);

  // Long-press state for holding down a year chip to open its offline sheet.
  const pressRef = useRef<{
    year: number;
    timer: ReturnType<typeof setTimeout>;
    x: number;
    y: number;
  } | null>(null);
  const suppressClickYear = useRef<number | null>(null);

  // A second at a time while counting down, so the next day opens the moment it unlocks.
  const upcoming = nextUnlock();
  const now = useNow(1000, upcoming !== null);
  const next = nextUnlock(now);
  const today = todaysPuzzle(now);

  const loadAllCached = useCallback(async () => {
    const all = await listAocPuzzles();
    const byYear = new Map<number, Map<number, CachedDayInfo>>();
    for (const p of all) {
      if (!p.problem && !p.code) continue;
      let map = byYear.get(p.year);
      if (!map) {
        map = new Map();
        byYear.set(p.year, map);
      }
      map.set(p.day, {
        parts: p.problemParts ?? p.problem?.parts_html.length ?? 0,
        hasInput: p.input !== undefined,
        fullyCached: Boolean(p.problem && p.input !== undefined),
      });
    }
    return byYear;
  }, []);

  useEffect(() => {
    let cancelled = false;
    const refresh = () => {
      void loadAllCached().then((byYear) => {
        if (!cancelled) setCachedByYear(byYear);
      });
    };
    refresh();
    const unsub = yearSync().subscribe(() => {
      setSyncTick((n) => n + 1);
      refresh();
    });
    return () => {
      cancelled = true;
      unsub();
      if (pressRef.current) {
        clearTimeout(pressRef.current.timer);
        pressRef.current = null;
      }
    };
  }, [loadAllCached]);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    let fetchedFresh = false;
    setError(null);
    const cacheReady = getAocYear(year).then((cached) => {
      if (cancelled) return;
      if (cached?.stars && !fetchedFresh) {
        starsByYear.set(year, cached.stars);
        setLoaded({ year, stars: cached.stars });
      }
      const cachedTimes = cached?.times;
      if (cachedTimes && !fetchedFresh) {
        setTimes((prev) => (prev?.year === year ? prev : { year, times: cachedTimes }));
      }
    });
    if (!online) {
      return () => {
        cancelled = true;
      };
    }
    api
      .stars(year)
      .then((s) => {
        fetchedFresh = true;
        starsByYear.set(year, s);
        void mergeAocYear(year, { stars: s });
        if (!cancelled) {
          setLoaded({ year, stars: s });
          setError(null);
        }
      })
      .catch(async (e: unknown) => {
        await cacheReady;
        if (cancelled) return;
        if (isTransientNetworkError(e)) return;
        setError(`Couldn't load your stars: ${errorMessage(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [year, hasSession, online]);

  // Times are extra: without them the picker works just the same, so failing is quiet.
  useEffect(() => {
    if (!hasSession || !online) return;
    let cancelled = false;
    api
      .times(year)
      .then((t) => {
        void mergeAocYear(year, { times: t });
        if (!cancelled) setTimes({ year, times: t });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [year, hasSession, online]);
  const yearTimes = times?.year === year ? Object.entries(times.times) : [];

  // Only when one's chosen: the server says so by returning nothing.
  const [board, setBoard] = useState<{ year: number; members: LeaderboardMember[] } | null>(null);
  const [boardError, setBoardError] = useState<string | null>(null);
  useEffect(() => {
    if (!hasSession || !online) return;
    let cancelled = false;
    setBoardError(null);
    api
      .leaderboard(year)
      .then((members) => !cancelled && setBoard(members ? { year, members } : null))
      .catch((e: unknown) => {
        if (cancelled) return;
        if (isTransientNetworkError(e)) return;
        setBoardError(`Couldn't load the leaderboard: ${errorMessage(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [year, hasSession, online]);
  const members = board?.year === year ? board.members : null;

  const cancelLongPress = () => {
    if (pressRef.current) {
      clearTimeout(pressRef.current.timer);
      pressRef.current = null;
    }
  };

  const onYearPointerDown = (targetYear: number, e: PointerEvent) => {
    if (e.button !== 0 && e.pointerType === "mouse") return;
    cancelLongPress();
    const x = e.clientX;
    const y = e.clientY;
    const timer = setTimeout(() => {
      pressRef.current = null;
      suppressClickYear.current = targetYear;
      setOfflineSheetYear(targetYear);
    }, LONG_PRESS_MS);
    pressRef.current = { year: targetYear, timer, x, y };
  };

  const onYearPointerMove = (e: PointerEvent) => {
    const press = pressRef.current;
    if (!press) return;
    if (Math.hypot(e.clientX - press.x, e.clientY - press.y) > LONG_PRESS_DRIFT_PX) {
      cancelLongPress();
    }
  };

  const onYearPointerEnd = (targetYear: number) => {
    cancelLongPress();
    if (suppressClickYear.current === targetYear) {
      setTimeout(() => {
        if (suppressClickYear.current === targetYear) suppressClickYear.current = null;
      }, 400);
    }
  };

  const onYearClick = (targetYear: number) => {
    if (suppressClickYear.current === targetYear) {
      suppressClickYear.current = null;
      return;
    }
    setYear(targetYear);
  };

  const years: number[] = [];
  for (let y = latestYear(now); y >= 2015; y--) years.push(y);

  const cachedDays = cachedByYear.get(year) ?? new Map<number, CachedDayInfo>();
  const unlockedCount = unlockedDaysFor(year, now).length;
  const fullyCachedCount = Array.from(cachedDays.values()).filter((d) => d.fullyCached).length;
  const cachedCount = cachedDays.size;
  const total = stars === null ? null : Object.values(stars).reduce((a, b) => a + b, 0);
  const status = !hasSession
    ? "Add your session cookie to see stars."
    : (error ??
      (total !== null
        ? `${total} stars in ${year}`
        : !online
          ? cachedCount > 0
            ? `${cachedCount} saved offline in ${year}`
            : `Offline · no saved puzzles in ${year}`
          : "Loading stars…"));

  const yearJob = yearSync().get(year);
  const activeJob = yearSync().active();
  const offlinePillLabel = yearJob?.active
    ? `Saving ${yearJob.completed}/${yearJob.total}…`
    : unlockedCount > 0 && fullyCachedCount >= unlockedCount
      ? `${fullyCachedCount}/${unlockedCount} offline ✓`
      : fullyCachedCount > 0
        ? `${fullyCachedCount}/${unlockedCount} offline ↓`
        : "Offline ↓";

  // State for whichever year's offline sheet is currently open (may differ from selected year on long-press).
  const sheetCached =
    offlineSheetYear !== null
      ? (cachedByYear.get(offlineSheetYear) ?? new Map<number, CachedDayInfo>())
      : null;
  const sheetUnlocked = offlineSheetYear !== null ? unlockedDaysFor(offlineSheetYear, now) : [];
  const sheetFullyCached = sheetCached
    ? Array.from(sheetCached.values()).filter((d) => d.fullyCached).length
    : 0;
  const sheetAnyCached = sheetCached?.size ?? 0;
  const sheetRemaining =
    offlineSheetYear !== null && sheetCached
      ? remainingDaysFor(
          offlineSheetYear,
          now,
          sheetCached,
          starsByYear.get(offlineSheetYear) ?? null,
        )
      : [];
  const sheetJob = offlineSheetYear !== null ? yearSync().get(offlineSheetYear) : null;

  return (
    <div class="picker">
      <div class="years">
        {years.map((y) => {
          const yCached = cachedByYear.get(y);
          const hasCached = (yCached?.size ?? 0) > 0;
          const isDownloading = activeJob?.year === y;
          return (
            <button
              type="button"
              key={y}
              class={`chip year-chip ${y === year ? "selected" : ""} ${hasCached ? "cached" : ""} ${isDownloading ? "downloading" : ""}`}
              title="Tap to view · Hold for offline options"
              onPointerDown={(e) => onYearPointerDown(y, e)}
              onPointerMove={onYearPointerMove}
              onPointerUp={() => onYearPointerEnd(y)}
              onPointerCancel={() => onYearPointerEnd(y)}
              onContextMenu={(e) => {
                e.preventDefault();
                cancelLongPress();
                setOfflineSheetYear(y);
              }}
              onClick={() => onYearClick(y)}
            >
              {y}
            </button>
          );
        })}
      </div>
      <div class="picker-status">
        <p class="muted">{status}</p>
        {hasSession || cachedCount > 0 ? (
          <button
            type="button"
            class={`chip offline-pill ${yearJob?.active ? "downloading" : unlockedCount > 0 && fullyCachedCount >= unlockedCount ? "complete" : ""}`}
            onClick={() => setOfflineSheetYear(year)}
          >
            {offlinePillLabel}
          </button>
        ) : null}
      </div>
      {yearJob?.error && offlineSheetYear !== year ? (
        <p class="muted small">{yearJob.error}</p>
      ) : null}
      {next && next.puzzle.year === year ? (
        <p class="countdown">
          Day {next.puzzle.day} unlocks in <strong>{formatCountdown(next.at - now)}</strong>
        </p>
      ) : null}
      <div class={`days ${hasSession && online && stars === null ? "loading" : ""}`}>
        {Array.from({ length: daysIn(year) }, (_, i) => i + 1).map((day) => {
          const count = stars?.[String(day)] ?? 0;
          const isCurrent = current?.year === year && current.day === day;
          const locked = !isUnlocked(year, day, now);
          const isToday = today?.year === year && today.day === day;
          const cached = cachedDays.get(day);
          const cachedTitle = cached
            ? cached.parts >= 2
              ? "Saved offline (Parts 1 & 2)"
              : cached.parts === 1
                ? "Saved offline (Part 1)"
                : "Code saved offline"
            : undefined;
          return (
            <button
              type="button"
              key={day}
              class={`day ${isCurrent ? "selected" : ""} ${locked ? "locked" : ""} ${isToday ? "today" : ""} ${cached ? "cached" : ""}`}
              disabled={locked}
              title={cachedTitle}
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
      {offlineSheetYear !== null ? (
        <Modal
          title={`Offline · ${offlineSheetYear}`}
          shape="sheet"
          onClose={() => setOfflineSheetYear(null)}
        >
          <div class="offline-year-sheet">
            <p class="offline-year-summary">
              <strong>{sheetFullyCached}</strong> of {sheetUnlocked.length} unlocked{" "}
              {sheetUnlocked.length === 1 ? "day" : "days"} saved on this device.
            </p>
            {sheetJob?.active ? (
              <div class="offline-year-progress">
                <div class="offline-progress-track" aria-hidden="true">
                  <div
                    class="offline-progress-fill"
                    style={{
                      width: `${sheetJob.total > 0 ? Math.round((sheetJob.completed / sheetJob.total) * 100) : 0}%`,
                    }}
                  />
                </div>
                <p class="muted small">
                  Downloading day {sheetJob.currentDay ?? "…"} ({sheetJob.completed}/
                  {sheetJob.total} in this batch). You can close this and keep coding — each day
                  saves as it arrives.
                </p>
              </div>
            ) : sheetJob?.error ? (
              <p class="muted small">{sheetJob.error}</p>
            ) : sheetJob?.paused ? (
              <p class="muted small">Paused — days already downloaded stay saved on this device.</p>
            ) : null}

            <div class="offline-year-actions">
              {sheetJob?.active ? (
                <button
                  type="button"
                  class="pill"
                  onClick={() => yearSync().pause(offlineSheetYear)}
                >
                  Pause download
                </button>
              ) : sheetRemaining.length > 0 && hasSession ? (
                <>
                  {sheetRemaining.length > 5 ? (
                    <button
                      type="button"
                      class="pill primary"
                      disabled={!online}
                      onClick={() =>
                        void yearSync().start(offlineSheetYear, sheetRemaining.slice(0, 5))
                      }
                    >
                      Save next 5 days
                    </button>
                  ) : null}
                  <button
                    type="button"
                    class={sheetRemaining.length > 5 ? "pill" : "pill primary"}
                    disabled={!online}
                    onClick={() => void yearSync().start(offlineSheetYear, sheetRemaining)}
                  >
                    {sheetFullyCached > 0
                      ? `Save remaining (${sheetRemaining.length} ${sheetRemaining.length === 1 ? "day" : "days"})`
                      : `Save all ${sheetRemaining.length} days`}
                  </button>
                </>
              ) : sheetUnlocked.length > 0 && sheetRemaining.length === 0 ? (
                <p class="muted small">
                  Every unlocked day in {offlineSheetYear} is saved offline.
                </p>
              ) : null}

              {sheetAnyCached > 0 ? (
                <button
                  type="button"
                  class="text-button"
                  onClick={() => void yearSync().removeYear(offlineSheetYear)}
                >
                  Remove saved puzzles for {offlineSheetYear}
                </button>
              ) : null}
            </div>

            {!sheetJob?.active && sheetRemaining.length > 0 && hasSession ? (
              <p class="muted small">
                {online
                  ? "Downloads one day at a time (~6 s each for Advent of Code's rate limit) and resumes where it left off if interrupted."
                  : "Reconnect to download the remaining days."}
              </p>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}
