import { useEffect, useRef } from "preact/hooks";

/** How long Ctrl must be held on its own before it counts as talking, rather than a shortcut. */
export const TALK_KEY_HOLD_MS = 200;

interface Talk {
  startHeld: () => void;
  stop: () => Promise<void>;
  abandonHeld: () => Promise<void>;
}

/**
 * Talking by holding Ctrl, on a computer, as the button is held on a phone. Held on its own, Ctrl
 * does nothing on any system, so it's free; pressed with another key or a click, it's a shortcut,
 * and anything heard is dropped.
 */
export function useTalkKey(enabled: boolean, talk: Talk): void {
  const latest = useRef({ enabled, talk });
  latest.current = { enabled, talk };

  useEffect(() => {
    /** Ctrl is up; it's down and may become talking; it's talking; or it's part of a shortcut. */
    let state: "idle" | "pending" | "talking" | "shortcut" = "idle";
    let timer: ReturnType<typeof setTimeout> | undefined;

    const shortcut = () => {
      clearTimeout(timer);
      if (state === "talking") void latest.current.talk.abandonHeld();
      if (state !== "idle") state = "shortcut";
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Control") {
        shortcut();
        return;
      }
      if (event.repeat || state !== "idle") return;
      if (event.altKey || event.metaKey || event.shiftKey || !latest.current.enabled) {
        state = "shortcut";
        return;
      }
      state = "pending";
      timer = setTimeout(() => {
        if (state !== "pending") return;
        state = "talking";
        latest.current.talk.startHeld();
      }, TALK_KEY_HOLD_MS);
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key !== "Control") return;
      clearTimeout(timer);
      if (state === "talking") void latest.current.talk.stop();
      state = "idle";
    };
    // The key's release goes elsewhere once the window loses focus; what was said is kept.
    const onBlur = () => {
      clearTimeout(timer);
      if (state === "talking") void latest.current.talk.stop();
      state = "idle";
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("pointerdown", shortcut, true);
    window.addEventListener("blur", onBlur);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("pointerdown", shortcut, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);
}
