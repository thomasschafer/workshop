import { useEffect, useState } from "preact/hooks";
import { errorMessage } from "../errors";
import { tracksApi } from "./api";
import "./home.css";
import type { Destination, Home as HomeState, Track } from "./types";

/** The home screen: one button that continues with the next best step, and the tracks. */
export function Home({ onGo }: { onGo: (destination: Destination) => void }) {
  const [home, setHome] = useState<HomeState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setError(null);
    tracksApi
      .home()
      .then((loaded) => !cancelled && setHome(loaded))
      .catch((e: unknown) => !cancelled && setError(errorMessage(e)));
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const next = home?.continue ?? null;
  return (
    <div class="home">
      <header class="top">
        <h1 class="app-title">Workshop</h1>
      </header>
      <main class="home-content">
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
          </>
        )}
      </main>
    </div>
  );
}

function trackName(tracks: Track[], id: Track["id"]): string {
  return tracks.find((track) => track.id === id)?.name ?? id;
}
