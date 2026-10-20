import type { Puzzle, Tab } from "../api";
import { puzzleLabel } from "../puzzle";

const TABS = ["problem", "code", "notes", "discuss"] as const;

/** The top bar: the open puzzle, which opens the picker, and buttons for help and settings. */
export function Header({
  showPicker,
  puzzle,
  stars,
  onBack,
  onPick,
  onHelp,
  onSettings,
}: {
  showPicker: boolean;
  puzzle: Puzzle | null;
  stars: string;
  /** Closes the picker, back to the open puzzle. */
  onBack: () => void;
  onPick: () => void;
  onHelp: () => void;
  onSettings: () => void;
}) {
  return (
    <header class="top">
      <h1 class="visually-hidden">Workshop</h1>
      {showPicker ? (
        puzzle ? (
          <button type="button" class="puzzle-button" onClick={onBack}>
            ‹ Back to {puzzleLabel(puzzle)}
          </button>
        ) : (
          <h1 class="app-title">Workshop</h1>
        )
      ) : (
        <button type="button" class="puzzle-button" onClick={onPick}>
          {puzzle ? puzzleLabel(puzzle) : ""}
          {stars ? <span class="stars"> {stars}</span> : null}
        </button>
      )}
      <span class="header-actions">
        <button type="button" class="icon-button" aria-label="Help" onClick={onHelp}>
          ?
        </button>
        <button type="button" class="icon-button" aria-label="Settings" onClick={onSettings}>
          ⚙
        </button>
      </span>
    </header>
  );
}

/** The tabs, without Problem on a wide screen, where the puzzle has a column of its own. */
export function Tabs({
  hidden,
  wide,
  shown,
  onTab,
}: {
  hidden: boolean;
  wide: boolean;
  shown: Tab;
  onTab: (tab: Tab) => void;
}) {
  return (
    <nav class={`tabs ${hidden ? "hidden" : ""}`}>
      {(wide ? (["code", "notes", "discuss"] as const) : TABS).map((t) => (
        <button
          type="button"
          key={t}
          class={t === shown ? "selected" : ""}
          onClick={() => onTab(t)}
        >
          {t === "discuss" ? "Discuss" : t[0]?.toUpperCase() + t.slice(1)}
        </button>
      ))}
    </nav>
  );
}
