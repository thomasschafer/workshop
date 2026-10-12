import { useLayoutEffect, useRef } from "preact/hooks";

// Open overlays share one history entry, so the back button (or gesture) closes the topmost
// one rather than leaving the app. Changes are reconciled after each render, so swapping one
// overlay for another keeps the entry rather than going back and forward.
const open: { close: () => void }[] = [];
let pushed = false;
let ignoredPops = 0;
let reconciling = false;

function reconcile(): void {
  if (reconciling) return;
  reconciling = true;
  queueMicrotask(() => {
    reconciling = false;
    if (open.length > 0 && !pushed) {
      history.pushState({ workshopOverlay: true }, "");
      pushed = true;
    } else if (open.length === 0 && pushed) {
      pushed = false;
      ignoredPops++;
      history.back();
    }
  });
}

window.addEventListener("popstate", () => {
  if (ignoredPops > 0) {
    ignoredPops--;
    return;
  }
  if (!pushed) return;
  pushed = false;
  open.at(-1)?.close();
  // Anything still open underneath gets a history entry of its own.
  reconcile();
});

/** Closes an overlay, such as a modal or sheet, when the user goes back. */
export function useCloseOnBack(onClose: () => void): void {
  const latest = useRef(onClose);
  latest.current = onClose;
  // Before the overlay is shown, so going back as soon as it can be seen closes it.
  useLayoutEffect(() => {
    const entry = { close: () => latest.current() };
    open.push(entry);
    reconcile();
    return () => {
      const index = open.indexOf(entry);
      if (index === -1) throw new Error("An overlay closed that was never registered as open.");
      open.splice(index, 1);
      reconcile();
    };
  }, []);
}
