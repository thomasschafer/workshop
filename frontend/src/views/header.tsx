import type { Puzzle, Tab } from "../api";
import { puzzleLabel } from "../puzzle";
import { TAB_SHORTCUTS, withShortcut } from "../shortcuts";
import { TABS, tabLabel } from "../tabs";
import { ZenButton } from "./zen";

/**
 * The top bar: a button for the home screen, the open puzzle, which opens the picker, and
 * buttons for zen mode, the keyboard shortcuts, where there's a keyboard to use them, help and
 * settings.
 */
export function Header({
  showPicker,
  puzzle,
  stars,
  onBack,
  onHome,
  onPick,
  onZen,
  onShortcuts,
  onHelp,
  onSettings,
}: {
  showPicker: boolean;
  puzzle: Puzzle | null;
  stars: string;
  /** Closes the picker, back to the open puzzle. */
  onBack: () => void;
  onHome: () => void;
  onPick: () => void;
  /** Enters zen mode, or null where there's no code to show in it. */
  onZen: (() => void) | null;
  /** Lists the keyboard shortcuts, or null on a touch screen, which has no keyboard for them. */
  onShortcuts: (() => void) | null;
  onHelp: () => void;
  onSettings: () => void;
}) {
  return (
    <header class="top">
      <h1 class="visually-hidden">Workshop</h1>
      <span class="header-start">
        <button type="button" class="icon-button home-button" aria-label="Home" onClick={onHome}>
          ⌂
        </button>
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
      </span>
      <span class="header-actions">
        {onZen ? <ZenButton onClick={onZen} shortcut /> : null}
        {onShortcuts ? (
          <button
            type="button"
            class="icon-button"
            aria-label="Keyboard shortcuts"
            title={withShortcut("Keyboard shortcuts", "shortcuts")}
            onClick={onShortcuts}
          >
            <KeyboardIcon />
          </button>
        ) : null}
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

function KeyboardIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect
        x="1.5"
        y="4"
        width="13"
        height="8.5"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <path
        d="M4 7h1M7.5 7h1M11 7h1M5 10h6"
        stroke="currentColor"
        stroke-width="1.4"
        stroke-linecap="round"
      />
    </svg>
  );
}

/** A window with a column down its left, filled while the puzzle is in that column. */
function ColumnIcon({ filled }: { filled: boolean }) {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <rect
        x="1.5"
        y="2.5"
        width="13"
        height="11"
        rx="1.5"
        fill="none"
        stroke="currentColor"
        stroke-width="1.4"
      />
      <path d="M6 2.5v11" stroke="currentColor" stroke-width="1.4" />
      {filled ? <rect x="2.2" y="3.2" width="3.4" height="9.6" fill="currentColor" /> : null}
    </svg>
  );
}

/**
 * The tabs, without Problem where the puzzle has a column of its own beside the code. On a wide
 * screen, a button first moves the puzzle between that column and a tab of its own.
 */
export function Tabs({
  hidden,
  beside,
  shown,
  onTab,
  onBeside,
}: {
  hidden: boolean;
  /** Whether the puzzle is in its own column beside the code, rather than a tab. */
  beside: boolean;
  shown: Tab;
  onTab: (tab: Tab) => void;
  /** Moves the puzzle beside the code or into a tab, or null where the screen's too narrow. */
  onBeside: (() => void) | null;
}) {
  const besideLabel = beside ? "Show the puzzle as a tab" : "Show the puzzle beside the code";
  return (
    <nav class={`tabs ${hidden ? "hidden" : ""}`}>
      {onBeside ? (
        <button
          type="button"
          class="tab-column"
          aria-label={besideLabel}
          aria-pressed={beside}
          title={withShortcut(besideLabel, "problemBeside")}
          onClick={onBeside}
        >
          <ColumnIcon filled={beside} />
        </button>
      ) : null}
      {(beside ? TABS.filter((t) => t !== "problem") : TABS).map((t) => (
        <button
          type="button"
          key={t}
          class={t === shown ? "selected" : ""}
          title={withShortcut(tabLabel(t), TAB_SHORTCUTS[t])}
          onClick={() => onTab(t)}
        >
          {tabLabel(t)}
        </button>
      ))}
    </nav>
  );
}
