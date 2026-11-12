import { useCloseOnBack } from "../hooks/useCloseOnBack";

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

export function ZenButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      class="icon-button"
      aria-label="Zen mode"
      title="Zen mode: just the code and the keyboard"
      onClick={onClick}
    >
      <CornersIcon inward={false} />
    </button>
  );
}

/** Floats over the code while in zen mode, the only way out besides going back. */
export function ZenExit({ onExit }: { onExit: () => void }) {
  useCloseOnBack(onExit);
  return (
    <button type="button" class="zen-exit" aria-label="Leave zen mode" onClick={onExit}>
      <CornersIcon inward />
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
 * Hides the phone's own status and navigation bars, where the browser allows it. iPhones only
 * let video go full screen, so there zen mode keeps them.
 */
export async function enterFullscreen(): Promise<void> {
  overlayKeyboard(true);
  const root = document.documentElement;
  if (!document.fullscreenEnabled || typeof root.requestFullscreen !== "function") return;
  await root.requestFullscreen({ navigationUI: "hide" });
}

export async function exitFullscreen(): Promise<void> {
  overlayKeyboard(false);
  if (document.fullscreenElement) await document.exitFullscreen();
}
