import { useCallback, useEffect, useState } from "preact/hooks";
import {
  api,
  ConnectionError,
  type LeaderboardMember,
  type OfflineYear,
  type Puzzle,
  type StarTimes,
  TimeoutError,
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
import {
  getAocPuzzle,
  getAocYear,
  listAocPuzzles,
  mergeAocPuzzle,
  mergeAocYear,
  putHelpers,
} from "../offline/db";
import { isPractice, PRACTICE } from "../puzzle";

interface Props {
  current: Puzzle | null;
  hasSession: boolean;
  onPick: (puzzle: Puzzle) => void;
}

/** Stars already fetched this session, so switching back to a year is instant. */
const starsByYear = new Map<number, Record<string, number>>();

interface CachedDayInfo {
  parts: number;
  hasInput: boolean;
}

async function storeOfflineYear(data: OfflineYear): Promise<void> {
  for (const p of data.puzzles) {
    const existing = await getAocPuzzle(data.year, p.day);
    const patch: Parameters<typeof mergeAocPuzzle>[2] = {
      fileUri: p.file_uri,
      meta: p.meta,
    };
    if (p.problem !== null) patch.problem = p.problem;
    if (p.input !== null) patch.input = p.input;
    if (p.code !== null) {
      patch.code = p.code;
    } else if (!existing?.code) {
      patch.code = { text: data.template, version: data.empty_version, path: "" };
    }
    if (p.notes !== null) {
      patch.notes = p.notes;
    } else if (!existing?.notes) {
      patch.notes = { text: "", version: data.empty_version, path: "" };
    }
    await mergeAocPuzzle(data.year, p.day, patch);
  }
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
  const [cachedDays, setCachedDays] = useState<Map<number, CachedDayInfo>>(() => new Map());
  const [savingYear, setSavingYear] = useState<{
    year: number;
    caching: boolean;
    cached: number;
    total: number;
    error: string | null;
  } | null>(null);
  // A second at a time while counting down, so the next day opens the moment it unlocks.
  const upcoming = nextUnlock();
  const now = useNow(1000, upcoming !== null);
  const next = nextUnlock(now);
  const today = todaysPuzzle(now);

  const loadCachedForYear = useCallback(async (targetYear: number) => {
    const all = await listAocPuzzles();
    const map = new Map<number, CachedDayInfo>();
    for (const p of all) {
      if (p.year === targetYear && (p.problem || p.code)) {
        map.set(p.day, {
          parts: p.problemParts ?? p.problem?.parts_html.length ?? 0,
          hasInput: p.input !== undefined,
        });
      }
    }
    return map;
  }, []);

  useEffect(() => {
    let cancelled = false;
    void loadCachedForYear(year).then((map) => {
      if (!cancelled) setCachedDays(map);
    });
    return () => {
      cancelled = true;
    };
  }, [year, loadCachedForYear]);

  useEffect(() => {
    if (!hasSession) return;
    let cancelled = false;
    let fetchedFresh = false;
    let hasCached = starsByYear.has(year);
    setError(null);
    const cacheReady = getAocYear(year).then((cached) => {
      if (cancelled) return;
      if (cached?.stars && !fetchedFresh) {
        hasCached = true;
        starsByYear.set(year, cached.stars);
        setLoaded({ year, stars: cached.stars });
      }
      const cachedTimes = cached?.times;
      if (cachedTimes && !fetchedFresh) {
        setTimes((prev) => (prev?.year === year ? prev : { year, times: cachedTimes }));
      }
    });
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
        if ((e instanceof ConnectionError || e instanceof TimeoutError) && hasCached) return;
        setError(`Couldn't load your stars: ${errorMessage(e)}`);
      });
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
      .then((t) => {
        void mergeAocYear(year, { times: t });
        if (!cancelled) setTimes({ year, times: t });
      })
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
      .catch((e: unknown) => {
        if (cancelled) return;
        if (e instanceof ConnectionError || e instanceof TimeoutError) return;
        setBoardError(`Couldn't load the leaderboard: ${errorMessage(e)}`);
      });
    return () => {
      cancelled = true;
    };
  }, [year, hasSession]);
  const members = board?.year === year ? board.members : null;

  const syncOfflineYear = useCallback(
    async (targetYear: number): Promise<OfflineYear> => {
      const data = await api.offlineYear(targetYear);
      await storeOfflineYear(data);
      const map = await loadCachedForYear(targetYear);
      setCachedDays(map);
      setSavingYear({
        year: targetYear,
        caching: data.caching,
        cached: data.cached_days,
        total: data.total_unlocked,
        error: data.error,
      });
      return data;
    },
    [loadCachedForYear],
  );

  // Poll the lightweight status endpoint while the server's throttled prefetch is running,
  // fetching the full offline bundle only once caching finishes.
  useEffect(() => {
    if (!savingYear || savingYear.year !== year || !savingYear.caching) return;
    let cancelled = false;
    const timer = setInterval(() => {
      void api
        .cacheYearStatus(year)
        .then(async (status) => {
          if (cancelled) return;
          if (!status.caching) {
            await syncOfflineYear(year);
          } else {
            setSavingYear({
              year,
              caching: status.caching,
              cached: status.cached_days,
              total: status.total_unlocked,
              error: status.error,
            });
          }
        })
        .catch((e: unknown) => {
          if (!cancelled) {
            setSavingYear((prev) =>
              prev?.year === year ? { ...prev, caching: false, error: errorMessage(e) } : prev,
            );
          }
        });
    }, 2500);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [savingYear?.year, savingYear?.caching, year, syncOfflineYear]);

  const saveYearOffline = async () => {
    setSavingYear({
      year,
      caching: true,
      cached: cachedDays.size,
      total: Array.from({ length: daysIn(year) }, (_, i) => i + 1).filter((d) =>
        isUnlocked(year, d, now),
      ).length,
      error: null,
    });
    try {
      const helpers = await api.helpers().catch(() => null);
      if (helpers) {
        await putHelpers(helpers.language_id, helpers.file, helpers.text);
      }
      const status = await api.cacheYear(year);
      if (!status.caching) {
        await syncOfflineYear(year);
      } else {
        setSavingYear({
          year,
          caching: status.caching,
          cached: status.cached_days,
          total: status.total_unlocked,
          error: status.error,
        });
      }
    } catch (e) {
      setSavingYear((prev) =>
        prev?.year === year ? { ...prev, caching: false, error: errorMessage(e) } : prev,
      );
    }
  };

  const years: number[] = [];
  for (let y = latestYear(now); y >= 2015; y--) years.push(y);
  const total = stars === null ? null : Object.values(stars).reduce((a, b) => a + b, 0);
  const status = !hasSession
    ? "Add your session cookie to see stars."
    : (error ?? (total === null ? "Loading stars…" : `${total} stars in ${year}`));
  const yearSave = savingYear?.year === year ? savingYear : null;
  const cachedCount = cachedDays.size;

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
      <div class="picker-status">
        <p class="muted">{status}</p>
        {hasSession ? (
          <button
            type="button"
            class="text-button"
            disabled={!online || yearSave?.caching === true}
            onClick={() => void saveYearOffline()}
          >
            {yearSave?.caching
              ? `Saving offline (${yearSave.cached}/${yearSave.total})…`
              : cachedCount > 0
                ? `Save ${year} offline (${cachedCount} cached)`
                : `Save ${year} for offline`}
          </button>
        ) : null}
      </div>
      {yearSave?.error ? <p class="error-text small">{yearSave.error}</p> : null}
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
    </div>
  );
}
