import { useEffect, useRef } from "preact/hooks";
import { isApple, matchShortcut, type ShortcutId } from "../shortcuts";

/**
 * Runs the app's keyboard shortcuts, wherever the focus is. `handlers` says what each does now,
 * or null where it has nothing to do, such as running with no puzzle open: the key press is then
 * left alone, to do what it otherwise would.
 */
export function useShortcuts(handlers: Record<ShortcutId, (() => void) | null>): void {
  const latest = useRef(handlers);
  latest.current = handlers;
  useEffect(() => {
    const mac = isApple();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.repeat || event.isComposing) return;
      const id = matchShortcut(event, mac);
      const handler = id === null ? null : latest.current[id];
      if (handler === null) return;
      // Before the code's own keys, so a shortcut does the same thing with any keybindings.
      event.preventDefault();
      event.stopPropagation();
      handler();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, []);
}
