import type { ComponentChildren } from "preact";
import { TrackIcon } from "../tracks/icons";
import type { TrackIcon as TrackIconName } from "../tracks/types";
import "../learning/practice.css";
import "./progress.css";

/**
 * A screen of its own, with a way home: the layout the mistake log, goals, packs, design sessions
 * and timed rounds share, the last two with their track's icon.
 */
export function Page({
  title,
  icon,
  onHome,
  children,
}: {
  title: string;
  icon?: TrackIconName;
  onHome: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="learn">
      <header class="top">
        <span class="header-start">
          <HomeButton onHome={onHome} />
          <TrackTitle title={title} icon={icon} />
        </span>
      </header>
      <main class="learn-content">{children}</main>
    </div>
  );
}

/** The button back to the home screen, at the start of every screen's top bar. */
export function HomeButton({ onHome }: { onHome: () => void }) {
  return (
    <button type="button" class="icon-button home-button" aria-label="Home" onClick={onHome}>
      ⌂
    </button>
  );
}

/** A screen's title in its top bar, with its track's icon if it's a track's. */
export function TrackTitle({ title, icon }: { title: string; icon?: TrackIconName | undefined }) {
  return (
    <h1 class="app-title">
      {icon ? <TrackIcon icon={icon} size={16} /> : null}
      {title}
    </h1>
  );
}

/** Loading, or why something couldn't be loaded, with a way to try again. */
export function Loading({ error, onRetry }: { error: string | null; onRetry: () => void }) {
  if (error === null) return <p class="muted">Loading…</p>;
  return (
    <div class="progress-error">
      <p class="error-text">{error}</p>
      <button type="button" class="pill" onClick={onRetry}>
        Try again
      </button>
    </div>
  );
}
