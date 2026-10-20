import type { RefObject } from "preact";
import { useEffect, useRef } from "preact/hooks";
import type { Puzzle } from "../api";
import { nextUnlock, todaysPuzzle } from "../calendar";
import { onNotificationOpen, puzzleToOpen } from "../notifications";
import * as preferences from "../preferences";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * While the event runs, a new puzzle is offered once on each device: when the app opens, or
 * the moment it unlocks if the app's open then.
 */
export function usePuzzleOffers(
  queue: { offer: (text: string, action: string, act: () => void) => void },
  puzzleRef: RefObject<Puzzle | null>,
  openPuzzle: (p: Puzzle) => void,
): void {
  const openPuzzleRef = useRef(openPuzzle);
  openPuzzleRef.current = openPuzzle;
  // A tapped notification opens its puzzle: in a new window, through the address; in one
  // already open, through a message from the service worker.
  useEffect(() => {
    const fromAddress = puzzleToOpen(location.search);
    if (fromAddress) {
      history.replaceState(history.state, "", location.pathname);
      openPuzzleRef.current(fromAddress);
    }
    return onNotificationOpen((year, day) => openPuzzleRef.current({ year, day }));
  }, []);
  useEffect(() => {
    const offerToday = () => {
      const today = todaysPuzzle();
      const current = puzzleRef.current;
      if (!today || (current?.year === today.year && current.day === today.day)) return;
      const key = `${today.year}-${today.day}`;
      if (preferences.puzzleOffered.get() === key) return;
      preferences.puzzleOffered.set(key);
      queue.offer(`Day ${today.day} is out.`, "Open it", () => openPuzzleRef.current(today));
    };
    offerToday();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waitForNext = () => {
      const next = nextUnlock();
      // Timers can't wait more than about 24 days; a day at a time is plenty.
      if (next) timer = setTimeout(onUnlock, Math.min(next.at - Date.now() + 1000, DAY_MS));
    };
    const onUnlock = () => {
      offerToday();
      waitForNext();
    };
    waitForNext();
    return () => clearTimeout(timer);
  }, []);
}
