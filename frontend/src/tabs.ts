import type { Tab } from "./api";

/** The tabs, in the order they're shown and swept through. */
export const TABS = ["problem", "code", "notes", "discuss"] as const;

export const tabLabel = (tab: Tab): string =>
  tab === "discuss" ? "Discuss" : `${tab[0]?.toUpperCase() ?? ""}${tab.slice(1)}`;

/** The tab beside `tab`, or `tab` itself at either end. */
export function tabBeside(tab: Tab, direction: 1 | -1): Tab {
  const index = TABS.indexOf(tab);
  return TABS[Math.max(0, Math.min(TABS.length - 1, index + direction))] ?? tab;
}
