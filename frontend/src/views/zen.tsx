import { useState } from "preact/hooks";
import type { Tab } from "../api";
import { errorMessage } from "../errors";
import { useCloseOnBack } from "../hooks/useCloseOnBack";
import { TAB_SHORTCUTS, withShortcut } from "../shortcuts";
import { TABS, tabLabel } from "../tabs";

/** Corner brackets pointing out, to enter zen mode, or in, to leave it. */
function CornersIcon({ inward }: { inward: boolean }) {
  const corners = inward
    ? "M6 2v4H2M10 2v4h4M6 14v-4H2M10 14v-4h4"
    : "M2 6V2h4M14 6V2h-4M2 10v4h4M14 10v4h-4";
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <path
        d={corners}
        fill="none"
        stroke="currentColor"
        stroke-width="1.6"
        stroke-linecap="round"
        stroke-linejoin="round"
      />
    </svg>
  );
}

/** `shortcut` says whether the zen shortcut works here, for the hover text to give it. */
export function ZenButton({
  onClick,
  shortcut = false,
}: {
  onClick: () => void;
  shortcut?: boolean;
}) {
  const title = "Zen mode: just the code and the keyboard, full screen";
  return (
    <button
      type="button"
      class="icon-button"
      aria-label="Zen mode"
      title={shortcut ? withShortcut(title, "zen") : title}
      onClick={onClick}
    >
      <CornersIcon inward={false} />
    </button>
  );
}

/**
 * Floats over the code while in zen mode, the only way out besides going back and, where
 * `shortcut` says it works, the zen shortcut.
 */
export function ZenExit({ onExit, shortcut = false }: { onExit: () => void; shortcut?: boolean }) {
  useCloseOnBack(onExit);
  return (
    <button
      type="button"
      class="zen-exit"
      aria-label="Leave zen mode"
      title={shortcut ? withShortcut("Leave zen mode", "zen") : "Leave zen mode"}
      onClick={onExit}
    >
      <CornersIcon inward />
    </button>
  );
}

/**
 * The tabs in zen mode, where the usual ones are hidden: shown in full for a moment on turning to
 * one, then fading back to stay out of the way while still there to tap or click.
 */
export function ZenTabs({ shown, onTab }: { shown: Tab; onTab: (tab: Tab) => void }) {
  return (
    // Keyed by the tab, so turning to another starts the fade again.
    <nav key={shown} class="zen-tabs" aria-label="Tabs">
      {TABS.map((tab) => (
        <button
          type="button"
          key={tab}
          class={tab === shown ? "selected" : ""}
          aria-current={tab === shown ? "page" : undefined}
          title={withShortcut(tabLabel(tab), TAB_SHORTCUTS[tab])}
          onClick={() => onTab(tab)}
        >
          {tabLabel(tab)}
        </button>
      ))}
    </nav>
  );
}

/** Brings Workshop's own keyboard back up in zen mode, where the button that does so is hidden. */
export function ZenKeyboardButton({ onClick }: { onClick: () => void }) {
  return (
    <button type="button" class="zen-keyboard" aria-label="Show keyboard" onClick={onClick}>
      ⌨
    </button>
  );
}

/** Chrome's VirtualKeyboard API, which TypeScript doesn't describe yet. */
interface VirtualKeyboard {
  overlaysContent: boolean;
}

/**
 * Has the on-screen keyboard cover the page rather than shrink it, so the page can size itself
 * from `env(keyboard-inset-height)`. Full screen, Chrome on Android has shrunk the page by the
 * hidden status bar's height as well as the keyboard's, leaving an empty band above the
 * keyboard. Browsers without the API, such as Safari, shrink the page as usual.
 */
function overlayKeyboard(overlay: boolean): void {
  const keyboard = (navigator as Navigator & { virtualKeyboard?: VirtualKeyboard }).virtualKeyboard;
  if (keyboard) keyboard.overlaysContent = overlay;
}

/**
 * Zen mode: just the code and the keyboard, for typing on a phone without the rest of the screen
 * in the way, full screen where the browser allows it. Enter it in a tap, as browsers only go
 * full screen for something the user started; `warn` says what didn't work.
 */
export function useZen(warn: (text: string) => void) {
  const [on, setOn] = useState(false);
  const enter = () => {
    setOn(true);
    enterFullscreen().then(
      () =>
        keepEscape().catch((e: unknown) =>
          warn(`Escape will leave full screen: ${errorMessage(e)}`),
        ),
      (e: unknown) => warn(`Couldn't go full screen: ${errorMessage(e)}`),
    );
  };
  const exit = () => {
    setOn(false);
    exitFullscreen().catch((e: unknown) => warn(`Couldn't leave full screen: ${errorMessage(e)}`));
  };
  return { on, enter, exit };
}

/**
 * Hides the phone's own status and navigation bars, where the browser allows it. iPhones only
 * let video go full screen, so there zen mode keeps them.
 */
async function enterFullscreen(): Promise<void> {
  overlayKeyboard(true);
  const root = document.documentElement;
  if (!document.fullscreenEnabled || typeof root.requestFullscreen !== "function") return;
  await root.requestFullscreen({ navigationUI: "hide" });
}

/** Chromium's Keyboard Lock API, which TypeScript doesn't describe yet. */
interface KeyboardLock {
  lock(keys: string[]): Promise<void>;
}

/**
 * Has Escape go to the page while full screen, for Helix's keys, rather than leaving full
 * screen; holding it down leaves instead, as the browser says. Only Chromium has the API, so
 * elsewhere Escape still leaves. Only with a mouse or trackpad, as a phone has no Escape key of
 * its own to keep.
 */
async function keepEscape(): Promise<void> {
  const keyboard = (navigator as Navigator & { keyboard?: Partial<KeyboardLock> }).keyboard;
  if (typeof keyboard?.lock !== "function") return;
  if (!document.fullscreenElement || !window.matchMedia("(pointer: fine)").matches) return;
  await keyboard.lock(["Escape"]);
}

async function exitFullscreen(): Promise<void> {
  overlayKeyboard(false);
  if (document.fullscreenElement) await document.exitFullscreen();
}
