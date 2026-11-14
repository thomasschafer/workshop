import type { ComponentChildren } from "preact";
import "../learning/practice.css";
import "./progress.css";

/** A screen of its own, with a way home: the layout the mistake log, goals and packs share. */
export function Page({
  title,
  onHome,
  children,
}: {
  title: string;
  onHome: () => void;
  children: ComponentChildren;
}) {
  return (
    <div class="learn">
      <header class="top">
        <span class="header-start">
          <button type="button" class="icon-button home-button" aria-label="Home" onClick={onHome}>
            ⌂
          </button>
          <h1 class="app-title">{title}</h1>
        </span>
      </header>
      <main class="learn-content">{children}</main>
    </div>
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
