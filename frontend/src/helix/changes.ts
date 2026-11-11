// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): how helix-core's transaction.rs maps
// positions and selections through a set of changes.

import { Range, Selection } from "./selection";
import { charIsWord } from "./text";

/** Replaces `from..to` with `insert`, in the coordinates of the text before any change. */
export interface Change {
  readonly from: number;
  readonly to: number;
  readonly insert: string;
}

export enum Assoc {
  Before,
  After,
  /** After if a word character is inserted after the position, otherwise before. */
  AfterWord,
  /** Before if a word character is inserted before the position, otherwise after. */
  BeforeWord,
  /** Before, but keeping the offset into a replacement of the same size. */
  BeforeSticky,
  /** After, but keeping the offset into a replacement of the same size. */
  AfterSticky,
}

function stayAtGaps(assoc: Assoc): boolean {
  return assoc !== Assoc.BeforeWord && assoc !== Assoc.AfterWord;
}

function sticky(assoc: Assoc): boolean {
  return assoc === Assoc.BeforeSticky || assoc === Assoc.AfterSticky;
}

function insertOffset(assoc: Assoc, s: string): number {
  switch (assoc) {
    case Assoc.After:
    case Assoc.AfterSticky:
      return s.length;
    case Assoc.Before:
    case Assoc.BeforeSticky:
      return 0;
    case Assoc.AfterWord: {
      let n = 0;
      while (n < s.length && charIsWord(s.charAt(n))) n++;
      return n;
    }
    case Assoc.BeforeWord: {
      let n = 0;
      while (n < s.length && charIsWord(s.charAt(s.length - 1 - n))) n++;
      return s.length - n;
    }
  }
}

/**
 * Checks `changes` are sorted and don't overlap, as every set of changes must be, and drops
 * changes that do nothing.
 */
export function normalizeChanges(changes: readonly Change[], length: number): Change[] {
  let last = 0;
  const out: Change[] = [];
  for (const change of changes) {
    if (change.from < last || change.to < change.from || change.to > length) {
      throw new Error(
        `changes must be in order and within the text: ${JSON.stringify(changes)} in ${length}`,
      );
    }
    last = change.to;
    if (change.from !== change.to || change.insert !== "") out.push(change);
  }
  return out;
}

export function applyChanges(text: string, changes: readonly Change[]): string {
  let out = "";
  let last = 0;
  for (const change of changes) {
    out += text.slice(last, change.from) + change.insert;
    last = change.to;
  }
  return out + text.slice(last);
}

/** Where `pos` ends up after `changes`. */
export function mapPos(changes: readonly Change[], pos: number, assoc: Assoc): number {
  let delta = 0;
  for (const change of changes) {
    if (pos < change.from) break;
    const deleted = change.to - change.from;
    const newFrom = change.from + delta;
    if (deleted === 0) {
      if (pos === change.from) return newFrom + insertOffset(assoc, change.insert);
    } else if (pos < change.to) {
      if (change.insert === "") return newFrom;
      // Within a replacement.
      if (pos === change.from && stayAtGaps(assoc)) return newFrom;
      const ins = insertOffset(assoc, change.insert);
      // Keeps the offset into a replacement of exactly the same size.
      if (deleted === ins && sticky(assoc)) return newFrom + (pos - change.from);
      return newFrom + ins;
    }
    delta += change.insert.length - deleted;
  }
  return pos + delta;
}

/** Maps a range as Helix does, keeping its ends stuck to the text they're next to. */
export function mapRange(changes: readonly Change[], range: Range): Range {
  if (changes.length === 0) return range;
  if (range.anchor === range.head) {
    const pos = mapPos(changes, range.anchor, Assoc.AfterSticky);
    return new Range(pos, pos);
  }
  if (range.anchor < range.head) {
    return new Range(
      mapPos(changes, range.anchor, Assoc.AfterSticky),
      mapPos(changes, range.head, Assoc.BeforeSticky),
    );
  }
  return new Range(
    mapPos(changes, range.anchor, Assoc.BeforeSticky),
    mapPos(changes, range.head, Assoc.AfterSticky),
  );
}

export function mapSelection(changes: readonly Change[], selection: Selection): Selection {
  if (changes.length === 0) return selection;
  return selection.transform((r) => mapRange(changes, r));
}

/** Changes the deleted ranges, merging deletions that overlap, as `Transaction::delete` does. */
export function deletions(ranges: Iterable<readonly [number, number]>): Change[] {
  const out: Change[] = [];
  let last = 0;
  for (const [rawFrom, to] of ranges) {
    if (last > to) continue;
    const from = Math.max(rawFrom, last);
    out.push({ from, to, insert: "" });
    last = to;
  }
  return out;
}

/**
 * The changes, with a new selection where `f` gives one for a range and the range mapped through
 * its own change where it doesn't, as `Transaction::change_by_and_with_selection` makes.
 */
export function changeByAndWithSelection(
  selection: Selection,
  f: (range: Range) => [Change, Range | null],
): { changes: Change[]; selection: Selection } {
  const changes: Change[] = [];
  const ranges: Range[] = [];
  let offset = 0;
  for (const range of selection.ranges) {
    const [change, endRange] = f(range);
    const newRange = endRange ?? mapRange([change], range);
    ranges.push(new Range(newRange.anchor + offset, newRange.head + offset));
    offset += change.insert.length - (change.to - change.from);
    changes.push(change);
  }
  return { changes, selection: new Selection(ranges, selection.primaryIndex) };
}

/** As `Transaction::delete_by_and_with_selection`, where deletions may overlap. */
export function deleteByAndWithSelection(
  selection: Selection,
  f: (range: Range) => [[number, number], Range | null],
): { changes: Change[]; selection: Selection } {
  const dels: [number, number][] = [];
  const ranges: Range[] = [];
  let offset = 0;
  let last = 0;
  for (const range of selection.ranges) {
    const [[from, to], endRange] = f(range);
    const size = last > from ? to - last : to - from;
    const newRange = endRange ?? mapRange([{ from, to, insert: "" }], range);
    ranges.push(
      new Range(Math.max(0, newRange.anchor - offset), Math.max(0, newRange.head - offset)),
    );
    offset += size;
    last = to;
    dels.push([from, to]);
  }
  return { changes: deletions(dels), selection: new Selection(ranges, selection.primaryIndex) };
}
