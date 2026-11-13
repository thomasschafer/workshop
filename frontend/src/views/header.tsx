import type { Puzzle, Tab } from "../api";
import { puzzleLabel } from "../puzzle";
import { ZenButton } from "./zen";

/** The tabs, in the order they're shown and swept through. */
export const TABS = ["problem", "code", "notes", "discuss"] as const;

export const tabLabel = (tab: Tab): string =>
  tab === "discuss" ? "Discuss" : `${tab[0]?.toUpperCase() ?? ""}${tab.slice(1)}`;

/** The tab beside `tab`, or `tab` itself at either end. */
export function tabBeside(tab: Tab, direction: 1 | -1): Tab {
  const index = TABS.indexOf(tab);
  return TABS[Math.max(0, Math.min(TABS.length - 1, index + direction))] ?? tab;
}

/**
 * The top bar: the open puzzle, which opens the picker, and buttons for zen mode, help and
 * settings.
 */
export function Header({
  showPicker,
  puzzle,
  stars,
  onBack,
  onPick,
  onZen,
  onHelp,
  onSettings,
}: {
  showPicker: boolean;
  puzzle: Puzzle | null;
  stars: string;
  /** Closes the picker, back to the open puzzle. */
  onBack: () => void;
  onPick: () => void;
  /** Enters zen mode, or null where there's no code to show in it. */
  onZen: (() => void) | null;
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
        {onZen ? <ZenButton onClick={onZen} /> : null}
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
          {tabLabel(t)}
        </button>
      ))}
    </nav>
  );
}
