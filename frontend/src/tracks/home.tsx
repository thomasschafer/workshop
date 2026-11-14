import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { loadMarkdown } from "../hooks/useMarkdown";
import { learning } from "../learning/sync";
import { tracksApi } from "./api";
import "./home.css";
import { TrackIcon } from "./icons";
import type { Route } from "./routes";
import { aWhile as hasAWhile, setAWhile } from "./sitting";
import type { Destination, Home as HomeState, Track } from "./types";

/**
 * The home screen: one button that continues with the next best step, the tracks, and the
 * screens about how it's going.
 */
export function Home({
  onGo,
  onOpen,
}: {
  onGo: (destination: Destination) => void;
  onOpen: (route: Route) => void;
}) {
  const [home, setHome] = useState<HomeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [pending, setPending] = useState(() => learning().syncStatus.pending);
  const [aWhile, setAWhileShown] = useState(() => hasAWhile());

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // What was done offline is sent first, so what's suggested takes it into account.
    learning()
      .sync()
      .then(() => tracksApi.home(aWhile))
      .then((loaded) => !cancelled && setHome(loaded))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [attempt, aWhile]);

  // It can turn itself off while the home screen's open, if the learner leaves it there.
  useEffect(() => {
    if (!aWhile) return;
    const check = () => {
      if (!hasAWhile()) setAWhileShown(false);
    };
    const timer = setInterval(check, 60_000);
    document.addEventListener("visibilitychange", check);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", check);
    };
  }, [aWhile]);

  useEffect(() => learning().subscribe(() => setPending(learning().syncStatus.pending)), []);

  // So formatted items can be shown offline later, the renderer is fetched while online.
  useEffect(() => {
    loadMarkdown().catch(() => {});
  }, []);

  const next = home?.continue ?? null;
  return (
    <div class="home">
      <header class="top">
        <h1 class="app-title">Workshop</h1>
      </header>
      <main class="home-content">
        {pending > 0 ? (
          <p class="home-pending muted" role="status">
            {pending === 1 ? "1 answer" : `${pending} answers`} saved on this device, to sync when
            the server can be reached
          </p>
        ) : null}
        {error ? (
          <div class="home-error">
            <p class="error-text">Couldn't load your tracks: {error}</p>
            <button type="button" onClick={() => setAttempt((n) => n + 1)}>
              Try again
            </button>
          </div>
        ) : home === null ? (
          <p class="muted">Loading…</p>
        ) : (
          <>
            {next ? (
              <button type="button" class="continue" onClick={() => onGo(next.destination)}>
                <span class="continue-label">{next.long ? "Continue · long" : "Continue"}</span>
                <span class="continue-title">{next.title}</span>
                <span class="continue-reason">
                  {trackName(home.tracks, next.track)} · {next.reason}
                </span>
              </button>
            ) : null}
            <label class="a-while">
              <input
                type="checkbox"
                role="switch"
                aria-checked={aWhile}
                checked={aWhile}
                onChange={(event) => {
                  const on = event.currentTarget.checked;
                  setAWhile(on);
                  setAWhileShown(on);
                }}
              />
              <span class="a-while-text">
                <span class="a-while-name">I've got a while</span>
                <span class="a-while-summary">
                  {aWhile
                    ? "Continue can offer timed rounds and design sessions. Turns off once you've been away for half an hour."
                    : "For timed rounds and design sessions. Otherwise, everything takes a few minutes."}
                </span>
              </span>
            </label>
            {home.week ? <WeekProgress {...home.week} /> : null}
            <section aria-labelledby="tracks-heading">
              <h2 id="tracks-heading" class="tracks-heading">
                Tracks
              </h2>
              <ul class="tracks">
                {home.tracks.map((track) => (
                  <li key={track.id}>
                    <button type="button" class="track" onClick={() => onGo(track.destination)}>
                      <span class="track-icon-box">
                        <TrackIcon icon={track.icon} />
                      </span>
                      <span class="track-text">
                        <span class="track-name">{track.name}</span>
                        <span class="track-summary">{track.summary}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            <section aria-labelledby="progress-heading">
              <h2 id="progress-heading" class="tracks-heading">
                Progress
              </h2>
              <ul class="tracks">
                {(
                  [
                    [{ screen: "goals", goal: null }, "Goals", "How close each goal is"],
                    [{ screen: "mistakes" }, "Mistakes", "What's gone wrong, by kind"],
                    [{ screen: "pack" }, "Packs", "Flagged cards, and keeping packs up to date"],
                  ] as const
                ).map(([route, name, summary]) => (
                  <li key={name}>
                    <button type="button" class="home-link" onClick={() => onOpen(route)}>
                      <span class="home-link-name">{name}</span>
                      <span class="home-link-summary">{summary}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
            {home.problems.length > 0 ? (
              <section class="home-problems" aria-labelledby="problems-heading">
                <h2 id="problems-heading" class="tracks-heading">
                  Left out of your packs
                </h2>
                <ul>
                  {home.problems.map((problem) => (
                    <li key={problem}>{problem}</li>
                  ))}
                </ul>
                <p class="muted">
                  <code>workshop pack check</code> lists these too.
                </p>
              </section>
            ) : null}
          </>
        )}
      </main>
    </div>
  );
}

/** The week's practice so far, towards its target: a target to work towards, not a streak. */
function WeekProgress({ minutes, target }: { minutes: number; target: number }) {
  const share = target > 0 ? Math.min(1, minutes / target) : 1;
  return (
    <section class="week" aria-label="This week">
      <span class="week-label">
        {minutes >= target
          ? `This week's ${target} minutes are done`
          : `${minutes} of ${target} minutes this week`}
      </span>
      <meter class="meter" aria-label="This week's practice" min={0} max={1} value={share} />
    </section>
  );
}

function trackName(tracks: Track[], id: Track["id"]): string {
  return tracks.find((track) => track.id === id)?.name ?? id;
}
