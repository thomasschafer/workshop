// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's selection.rs.

import {
  at,
  type Doc,
  ensureGraphemeBoundaryNext,
  ensureGraphemeBoundaryPrev,
  graphemes,
  nextGraphemeBoundary,
  prevGraphemeBoundary,
} from "./text";

export enum Direction {
  Forward,
  Backward,
}

/**
 * A selection range. `anchor` and `head` are gaps between characters, in either order; by
 * convention a block cursor sits on the head side of the range, a grapheme inward from its edge.
 */
export class Range {
  constructor(
    readonly anchor: number,
    readonly head: number,
    /** The column vertical movement keeps to, once it has moved through shorter lines. */
    readonly goalColumn: number | null = null,
  ) {}

  static point(pos: number): Range {
    return new Range(pos, pos);
  }

  get from(): number {
    return Math.min(this.anchor, this.head);
  }

  get to(): number {
    return Math.max(this.anchor, this.head);
  }

  get length(): number {
    return this.to - this.from;
  }

  get empty(): boolean {
    return this.anchor === this.head;
  }

  get direction(): Direction {
    return this.head < this.anchor ? Direction.Backward : Direction.Forward;
  }

  equals(other: Range): boolean {
    return this.anchor === other.anchor && this.head === other.head;
  }

  /** The lines the range covers, inclusive. */
  lineRange(doc: Doc): [number, number] {
    const from = this.from;
    const to = this.empty ? this.to : Math.max(prevGraphemeBoundary(doc, this.to), from);
    return [doc.lineOf(from), doc.lineOf(to)];
  }

  flip(): Range {
    return new Range(this.head, this.anchor, this.goalColumn);
  }

  withDirection(direction: Direction): Range {
    return this.direction === direction ? this : this.flip();
  }

  overlaps(other: Range): boolean {
    return this.from === other.from || (this.to > other.from && other.to > this.from);
  }

  contains(pos: number): boolean {
    return this.from <= pos && pos < this.to;
  }

  /** Extends the range to cover at least `from` to `to`. */
  extend(from: number, to: number): Range {
    if (this.anchor <= this.head) {
      return new Range(Math.min(this.anchor, from), Math.max(this.head, to));
    }
    return new Range(Math.max(this.anchor, to), Math.min(this.head, from));
  }

  /** A range covering both, negotiating the direction between them. */
  merge(other: Range): Range {
    if (this.anchor > this.head && other.anchor > other.head) {
      return new Range(Math.max(this.anchor, other.anchor), Math.min(this.head, other.head));
    }
    return new Range(Math.min(this.from, other.from), Math.max(this.to, other.to));
  }

  fragment(doc: Doc): string {
    return doc.slice(this.from, this.to);
  }

  graphemeAligned(doc: Doc): Range {
    let anchor: number;
    let head: number;
    if (this.anchor === this.head) {
      anchor = head = ensureGraphemeBoundaryPrev(doc, this.anchor);
    } else if (this.anchor < this.head) {
      anchor = ensureGraphemeBoundaryPrev(doc, this.anchor);
      head = ensureGraphemeBoundaryNext(doc, this.head);
    } else {
      anchor = ensureGraphemeBoundaryNext(doc, this.anchor);
      head = ensureGraphemeBoundaryPrev(doc, this.head);
    }
    return new Range(anchor, head, anchor === this.anchor ? this.goalColumn : null);
  }

  /**
   * Widens an empty range to one grapheme by moving its head forward, which only fails at the
   * end of the document.
   */
  minWidth1(doc: Doc): Range {
    if (this.anchor !== this.head) return this;
    return new Range(this.anchor, nextGraphemeBoundary(doc, this.head), this.goalColumn);
  }

  /** Where the block cursor's left side is. */
  cursor(doc: Doc): number {
    return this.head > this.anchor ? prevGraphemeBoundary(doc, this.head) : this.head;
  }

  /**
   * Puts the left side of the block cursor at `pos`, extending the range or not. Both ends behave
   * as one-grapheme blocks.
   */
  putCursor(doc: Doc, pos: number, extend: boolean): Range {
    if (!extend) return Range.point(pos);
    let anchor = this.anchor;
    if (this.head >= this.anchor && pos < this.anchor) {
      anchor = nextGraphemeBoundary(doc, this.anchor);
    } else if (this.head < this.anchor && pos >= this.anchor) {
      anchor = prevGraphemeBoundary(doc, this.anchor);
    }
    return anchor <= pos
      ? new Range(anchor, nextGraphemeBoundary(doc, pos))
      : new Range(anchor, pos);
  }

  cursorLine(doc: Doc): number {
    return doc.lineOf(this.cursor(doc));
  }

  isSingleGrapheme(doc: Doc): boolean {
    return graphemes(this.fragment(doc)).length === 1;
  }

  withGoalColumn(goalColumn: number | null): Range {
    return new Range(this.anchor, this.head, goalColumn);
  }
}

/** One or more ranges, one of them primary. Ranges are kept sorted and never overlap. */
export class Selection {
  readonly ranges: readonly Range[];
  readonly primaryIndex: number;

  /** Sorts and merges `ranges`, keeping track of which is primary. */
  constructor(ranges: readonly Range[], primaryIndex: number) {
    if (ranges.length === 0) throw new Error("a selection needs at least one range");
    if (primaryIndex < 0 || primaryIndex >= ranges.length) {
      throw new RangeError(`primary index ${primaryIndex} is outside ${ranges.length} ranges`);
    }
    const [normalized, primary] = normalize(ranges, primaryIndex);
    this.ranges = normalized;
    this.primaryIndex = primary;
  }

  static single(anchor: number, head: number): Selection {
    return new Selection([new Range(anchor, head)], 0);
  }

  static point(pos: number): Selection {
    return Selection.single(pos, pos);
  }

  get primary(): Range {
    return at(this.ranges, this.primaryIndex);
  }

  get length(): number {
    return this.ranges.length;
  }

  intoSingle(): Selection {
    return this.ranges.length === 1 ? this : new Selection([this.primary], 0);
  }

  /** Adds a range, which becomes the primary one. */
  push(range: Range): Selection {
    return new Selection([...this.ranges, range], this.ranges.length);
  }

  remove(index: number): Selection {
    if (this.ranges.length < 2) throw new Error("can't remove the last range from a selection");
    const ranges = this.ranges.filter((_, i) => i !== index);
    let primary = this.primaryIndex;
    if (index < primary || primary === ranges.length) primary--;
    return new Selection(ranges, primary);
  }

  replace(index: number, range: Range): Selection {
    const ranges = [...this.ranges];
    ranges[index] = range;
    return new Selection(ranges, this.primaryIndex);
  }

  withPrimaryIndex(index: number): Selection {
    return new Selection(this.ranges, index);
  }

  transform(f: (range: Range, index: number) => Range): Selection {
    return new Selection(this.ranges.map(f), this.primaryIndex);
  }

  /** Merges every range into one, from the first to the last. */
  mergeRanges(): Selection {
    const first = at(this.ranges, 0);
    const last = at(this.ranges, this.ranges.length - 1);
    return new Selection([first.merge(last)], 0);
  }

  /** Merges ranges that touch. */
  mergeConsecutiveRanges(): Selection {
    let primary = this.primary;
    const out: Range[] = [];
    for (const range of this.ranges) {
      const prev = out[out.length - 1];
      if (prev && prev.to === range.from) {
        const merged = range.merge(prev);
        if (prev.equals(primary) || range.equals(primary)) primary = merged;
        out[out.length - 1] = merged;
      } else {
        out.push(range);
      }
    }
    return new Selection(
      out,
      out.findIndex((r) => r.equals(primary)),
    );
  }

  /** Every range at least one grapheme wide, and on grapheme boundaries. */
  ensureInvariants(doc: Doc): Selection {
    return this.transform((r) => r.minWidth1(doc).graphemeAligned(doc));
  }

  /** Each range collapsed to its block cursor. */
  cursors(doc: Doc): Selection {
    return this.transform((r) => Range.point(r.cursor(doc)));
  }

  fragments(doc: Doc): string[] {
    return this.ranges.map((r) => r.fragment(doc));
  }

  equals(other: Selection): boolean {
    return (
      this.primaryIndex === other.primaryIndex &&
      this.ranges.length === other.ranges.length &&
      this.ranges.every((r, i) => r.equals(at(other.ranges, i)))
    );
  }

  /** The line ranges the selection covers, with ranges on neighbouring lines joined up. */
  lineRanges(doc: Doc): [number, number][] {
    const out: [number, number][] = [];
    for (const range of this.ranges) {
      const [start, end] = range.lineRange(doc);
      const prev = out[out.length - 1];
      if (prev && start - prev[1] <= 1) {
        prev[1] = end;
      } else {
        out.push([start, end]);
      }
    }
    return out;
  }
}

function normalize(ranges: readonly Range[], primaryIndex: number): [Range[], number] {
  if (ranges.length < 2) return [[...ranges], primaryIndex];
  let primary = at(ranges, primaryIndex);
  // Stable, so equal starts keep their order, as Rust's unstable sort happens to in practice for
  // the inputs Helix gives it; the merge below treats them the same either way.
  const sorted = [...ranges].sort((a, b) => a.from - b.from);
  const out: Range[] = [];
  for (const range of sorted) {
    const prev = out[out.length - 1];
    if (prev?.overlaps(range)) {
      const merged = range.merge(prev);
      if (prev.equals(primary) || range.equals(primary)) primary = merged;
      out[out.length - 1] = merged;
    } else {
      out.push(range);
    }
  }
  const index = out.findIndex((r) => r.equals(primary));
  if (index === -1) throw new Error("the primary range was lost while normalizing a selection");
  return [out, index];
}

// ---- Selection operations that take a regex ----

/** Keeps (or removes) the ranges that match, or null if none would be left. */
export function keepOrRemoveMatches(
  doc: Doc,
  selection: Selection,
  regex: RegExp,
  remove: boolean,
): Selection | null {
  const kept = selection.ranges.filter((r) => {
    regex.lastIndex = 0;
    return regex.test(r.fragment(doc)) !== remove;
  });
  return kept.length > 0 ? new Selection(kept, 0) : null;
}

/** Selects every match within each range, or null if there are none. */
export function selectOnMatches(doc: Doc, selection: Selection, regex: RegExp): Selection | null {
  const out: Range[] = [];
  for (const sel of selection.ranges) {
    for (const [start, end] of findAll(doc, regex, sel.from, sel.to)) {
      const range = new Range(start, end);
      if (!range.equals(Range.point(sel.to))) out.push(range);
    }
  }
  return out.length > 0 ? new Selection(out, 0) : null;
}

export function splitOnNewline(doc: Doc, selection: Selection): Selection {
  const out: Range[] = [];
  for (const sel of selection.ranges) {
    if (sel.empty) {
      out.push(sel);
      continue;
    }
    let start = sel.from;
    const text = sel.fragment(doc);
    let offset = 0;
    for (;;) {
      const newline = text.indexOf("\n", offset);
      if (newline === -1) break;
      out.push(new Range(start, sel.from + newline));
      offset = newline + 1;
      start = sel.from + offset;
    }
    if (start < sel.to) out.push(new Range(start, sel.to));
  }
  return new Selection(out, 0);
}

export function splitOnMatches(doc: Doc, selection: Selection, regex: RegExp): Selection {
  const out: Range[] = [];
  for (const sel of selection.ranges) {
    if (sel.empty) {
      out.push(sel);
      continue;
    }
    let start = sel.from;
    for (const [matchStart, matchEnd] of findAll(doc, regex, sel.from, sel.to)) {
      out.push(new Range(start, matchStart));
      start = matchEnd;
    }
    if (start < sel.to) out.push(new Range(start, sel.to));
  }
  return new Selection(out, 0);
}

/**
 * Every match of `regex` within `from..to`, as Rust's `regex` finds them: matches don't overlap,
 * and an empty match right after another is skipped. `regex` must have the `g` flag.
 */
export function findAll(doc: Doc, regex: RegExp, from: number, to: number): [number, number][] {
  if (!regex.global) throw new Error("findAll needs a global regex");
  const haystack = doc.slice(from, to);
  const out: [number, number][] = [];
  regex.lastIndex = 0;
  let lastEnd = -1;
  for (;;) {
    const match = regex.exec(haystack);
    if (match === null) break;
    const start = match.index;
    const end = start + match[0].length;
    if (end === start) {
      // Step past an empty match so the search makes progress, by a whole character.
      const code = haystack.codePointAt(start);
      regex.lastIndex = start + (code !== undefined && code > 0xffff ? 2 : 1);
      if (start === lastEnd) continue;
    }
    out.push([from + start, from + end]);
    lastEnd = end;
    if (regex.lastIndex > haystack.length) break;
  }
  return out;
}
