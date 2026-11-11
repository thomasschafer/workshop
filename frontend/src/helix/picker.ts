// A list to pick from by typing part of what's wanted, as Helix's pickers are, such as the command
// palette.

import type { Context } from "./commands";

export interface PickerItem {
  readonly label: string;
  /** Shown beside the label, such as a command's keys and description. */
  readonly detail: string;
  readonly run: (cx: Context) => void | Promise<void>;
}

export interface Picker {
  readonly title: string;
  readonly items: readonly PickerItem[];
  query: string;
  /** The index into the matches of the highlighted item. */
  selected: number;
}

/**
 * How well `query` matches `text`, as a fuzzy finder scores it: higher is better, and null if
 * the query's characters don't all appear in order. Case is ignored unless the query has a
 * capital letter.
 */
export function fuzzyScore(query: string, text: string): number | null {
  if (query === "") return 0;
  const sensitive = /\p{Lu}/u.test(query);
  const q = sensitive ? query : query.toLowerCase();
  const t = sensitive ? text : text.toLowerCase();
  if (t === q) return 1_000_000;
  let score = 0;
  let ti = 0;
  let run = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return null;
    // Consecutive characters, and ones at the start of a word, count for more.
    run = found === ti ? run + 1 : 1;
    score += run * 10;
    if (found === 0 || /[\s_:\-./]/.test(t.charAt(found - 1))) score += 15;
    score -= Math.min(found - ti, 10);
    ti = found + 1;
  }
  if (t.startsWith(q)) score += 100;
  // Shorter matches are more likely what's wanted.
  return score - t.length * 0.1;
}

/** The items matching the picker's query, best first. */
export function pickerMatches(picker: Picker): readonly PickerItem[] {
  if (picker.query === "") return picker.items;
  const scored: [PickerItem, number][] = [];
  for (const item of picker.items) {
    const score = fuzzyScore(picker.query, item.label);
    if (score !== null) scored.push([item, score]);
  }
  return scored.sort((a, b) => b[1] - a[1]).map(([item]) => item);
}
