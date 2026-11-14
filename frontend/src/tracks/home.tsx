import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { loadMarkdown } from "../hooks/useMarkdown";
import { learning } from "../learning/sync";
import { tracksApi } from "./api";
import "./home.css";
import type { Destination, Home as HomeState, Track } from "./types";

/** The home screen: one button that continues with the next best step, and the tracks. */
export function Home({ onGo }: { onGo: (destination: Destination) => void }) {
  const [home, setHome] = useState<HomeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  const [pending, setPending] = useState(() => learning().syncStatus.pending);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    // What was done offline is sent first, so what's suggested takes it into account.
    learning()
      .sync()
      .then(() => tracksApi.home())
      .then((loaded) => !cancelled && setHome(loaded))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

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
                <span class="continue-label">Continue</span>
                <span class="continue-title">{next.title}</span>
                <span class="continue-reason">
                  {trackName(home.tracks, next.track)} · {next.reason}
                </span>
              </button>
            ) : null}
            {home.week ? <WeekProgress {...home.week} /> : null}
            <section aria-labelledby="tracks-heading">
              <h2 id="tracks-heading" class="tracks-heading">
                Tracks
              </h2>
              <ul class="tracks">
                {home.tracks.map((track) => (
                  <li key={track.id}>
                    <button type="button" class="track" onClick={() => onGo(track.destination)}>
                      <span class="track-name">{track.name}</span>
                      <span class="track-summary">{track.summary}</span>
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
