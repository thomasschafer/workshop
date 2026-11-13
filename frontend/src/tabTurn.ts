// Turning from one tab to another with a slide, the tab that's left going out one side as the
// next comes in from the other, by the browser's view transitions: it draws the tabs as they
// were and as they are, and animates between the two. Browsers without them just change tabs.

/** Which way the tabs go: forward to the next, or back to the one before. */
export type Turn = "forward" | "back";

/** How long a tab's change waits for the browser to be ready to slide, before going ahead without. */
const MAX_WAIT_MS = 150;

/** Counts turns, so one that ends doesn't end the styling of one begun since. */
let turns = 0;

/**
 * Makes `change`, which changes the tab that's showing, and slides between how the page looked
 * before it and after. Without view transitions, or for someone who's asked for less motion,
 * it only makes the change.
 */
export function turnTab(turn: Turn, change: () => void): void {
  const root = document.documentElement;
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (typeof document.startViewTransition !== "function" || still) {
    change();
    return;
  }
  const mine = ++turns;
  let changed = false;
  const changeOnce = () => {
    if (changed) return;
    changed = true;
    change();
  };
  // Says which way to slide, and marks out the tabs' part of the page as what slides, only for
  // as long as it does: marked out for good, it would sit beneath the controls and dialogs.
  root.dataset.tabTurn = turn;
  const transition = document.startViewTransition(async () => {
    changeOnce();
    // The page is drawn again just after the change is asked for, not as it's asked.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  // The browser makes the change once it has drawn the page as it was, which it puts off while
  // it isn't drawing, such as in a window that's covered. The tab mustn't wait on that.
  setTimeout(() => {
    if (changed) return;
    changeOnce();
    transition.skipTransition();
  }, MAX_WAIT_MS);
  const done = () => {
    if (turns === mine) delete root.dataset.tabTurn;
  };
  transition.finished.then(done, done);
}
