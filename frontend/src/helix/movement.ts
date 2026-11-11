// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's movement.rs.

import { Direction, Range } from "./selection";
import {
  CharCategory,
  categorizeChar,
  charIsLineEnding,
  charIsLowercase,
  charIsUppercase,
  charIsWhitespace,
  type Doc,
  graphemes,
  isEmptyLine,
  nextGraphemeBoundary,
  nthNextGraphemeBoundary,
  nthPrevGraphemeBoundary,
  prevGraphemeBoundary,
} from "./text";

export enum Movement {
  Extend,
  Move,
}

export function moveHorizontally(
  doc: Doc,
  range: Range,
  dir: Direction,
  count: number,
  behaviour: Movement,
): Range {
  const pos = range.cursor(doc);
  const newPos =
    dir === Direction.Forward
      ? nthNextGraphemeBoundary(doc, pos, count)
      : nthPrevGraphemeBoundary(doc, pos, count);
  return range.putCursor(doc, newPos, behaviour === Movement.Extend);
}

/** The column `pos` is displayed at within its line, with tabs reaching the next tab stop. */
export function visualColumn(doc: Doc, pos: number, tabWidth: number): number {
  const start = doc.lineStart(doc.lineOf(pos));
  let col = 0;
  for (const g of graphemes(doc.slice(start, pos))) col += graphemeWidth(g, col, tabWidth);
  return col;
}

/**
 * The position on `line` of the grapheme displayed at `col`, or the end of the line (its line
 * ending, if it has one) when the line is too short.
 */
export function posAtVisualColumn(doc: Doc, line: number, col: number, tabWidth: number): number {
  const start = doc.lineStart(line);
  const end = doc.lineEnd(line);
  let c = 0;
  let pos = start;
  for (const g of graphemes(doc.slice(start, end))) {
    const width = graphemeWidth(g, c, tabWidth);
    if (c + width > col) return pos;
    c += width;
    pos += g.length;
  }
  return end;
}

function graphemeWidth(g: string, col: number, tabWidth: number): number {
  return g === "\t" ? tabWidth - (col % tabWidth) : 1;
}

/** Moves by whole lines, ignoring soft wrapping. */
export function moveVertically(
  doc: Doc,
  range: Range,
  dir: Direction,
  count: number,
  behaviour: Movement,
  tabWidth: number,
): Range {
  const pos = range.cursor(doc);
  const lineIdx = doc.lineOf(pos);
  const newCol = range.goalColumn ?? visualColumn(doc, pos, tabWidth);
  let newLine = dir === Direction.Forward ? lineIdx + count : Math.max(0, lineIdx - count);
  if (newLine >= doc.lines - 1) newLine = doc.lines - 1;
  const newPos = posAtVisualColumn(doc, newLine, newCol, tabWidth);

  // Special case to avoid extending to the end of the last, empty line.
  if (behaviour === Movement.Extend && doc.line(newLine).length === 0) return range;

  return range.putCursor(doc, newPos, behaviour === Movement.Extend).withGoalColumn(newCol);
}

// ---- Words ----

export enum WordMotionTarget {
  NextWordStart,
  NextWordEnd,
  PrevWordStart,
  PrevWordEnd,
  NextLongWordStart,
  NextLongWordEnd,
  PrevLongWordStart,
  PrevLongWordEnd,
  NextSubWordStart,
  NextSubWordEnd,
  PrevSubWordStart,
  PrevSubWordEnd,
}

function isPrev(target: WordMotionTarget): boolean {
  return (
    target === WordMotionTarget.PrevWordStart ||
    target === WordMotionTarget.PrevLongWordStart ||
    target === WordMotionTarget.PrevSubWordStart ||
    target === WordMotionTarget.PrevWordEnd ||
    target === WordMotionTarget.PrevLongWordEnd ||
    target === WordMotionTarget.PrevSubWordEnd
  );
}

export function wordMove(doc: Doc, range: Range, count: number, target: WordMotionTarget): Range {
  const prev = isPrev(target);
  if ((prev && range.head === 0) || (!prev && range.head === doc.length)) return range;

  // Block-cursor semantics, and the anchor not affecting where the motion goes.
  let start: Range;
  if (prev) {
    start =
      range.anchor < range.head
        ? new Range(range.head, prevGraphemeBoundary(doc, range.head))
        : new Range(nextGraphemeBoundary(doc, range.head), range.head);
  } else {
    start =
      range.anchor < range.head
        ? new Range(prevGraphemeBoundary(doc, range.head), range.head)
        : new Range(range.head, nextGraphemeBoundary(doc, range.head));
  }

  let current = start;
  for (let i = 0; i < count; i++) {
    const next = rangeToTarget(doc, target, current);
    if (next.equals(current)) break;
    current = next;
  }
  return current;
}

/**
 * Helix's `range_to_target`, which walks the characters from the head. It only moves the anchor
 * when the head starts on a boundary, directly or after skipping line endings.
 */
function rangeToTarget(doc: Doc, target: WordMotionTarget, origin: Range): Range {
  const s = doc.str;
  let anchor = origin.anchor;
  let head = origin.head;
  if (!isPrev(target)) {
    let i = head;
    let prevCh: string | undefined = head > 0 ? s[head - 1] : undefined;
    while (i < s.length && charIsLineEnding(s.charAt(i))) {
      prevCh = s.charAt(i);
      i++;
      head++;
    }
    if (prevCh !== undefined && charIsLineEnding(prevCh)) anchor = head;
    const headStart = head;
    while (i < s.length) {
      const nextCh = s.charAt(i);
      i++;
      if (prevCh === undefined || reachedTarget(target, prevCh, nextCh)) {
        if (head === headStart) {
          anchor = head;
        } else {
          break;
        }
      }
      prevCh = nextCh;
      head++;
    }
  } else {
    let i = head;
    let prevCh: string | undefined = head < s.length ? s[head] : undefined;
    while (i > 0 && charIsLineEnding(s.charAt(i - 1))) {
      prevCh = s.charAt(i - 1);
      i--;
      head = Math.max(0, head - 1);
    }
    if (prevCh !== undefined && charIsLineEnding(prevCh)) anchor = head;
    const headStart = head;
    while (i > 0) {
      const nextCh = s.charAt(i - 1);
      i--;
      if (prevCh === undefined || reachedTarget(target, prevCh, nextCh)) {
        if (head === headStart) {
          anchor = head;
        } else {
          break;
        }
      }
      prevCh = nextCh;
      head = Math.max(0, head - 1);
    }
  }
  return new Range(anchor, head);
}

function isWordBoundary(a: string, b: string): boolean {
  return categorizeChar(a) !== categorizeChar(b);
}

function isLongWordBoundary(a: string, b: string): boolean {
  const ca = categorizeChar(a);
  const cb = categorizeChar(b);
  if (
    (ca === CharCategory.Word && cb === CharCategory.Punctuation) ||
    (ca === CharCategory.Punctuation && cb === CharCategory.Word)
  ) {
    return false;
  }
  return ca !== cb;
}

function isSubWordBoundary(a: string, b: string, dir: Direction): boolean {
  const ca = categorizeChar(a);
  const cb = categorizeChar(b);
  if (ca === CharCategory.Word && cb === CharCategory.Word) {
    if ((a === "_") !== (b === "_")) return true;
    // Directional: in `fooBar` there's a boundary between `o` and `B`, but not `B` and `a`.
    return dir === Direction.Forward
      ? charIsLowercase(a) && charIsUppercase(b)
      : charIsUppercase(a) && charIsLowercase(b);
  }
  return ca !== cb;
}

function reachedTarget(target: WordMotionTarget, prev: string, next: string): boolean {
  switch (target) {
    case WordMotionTarget.NextWordStart:
    case WordMotionTarget.PrevWordEnd:
      return isWordBoundary(prev, next) && (charIsLineEnding(next) || !charIsWhitespace(next));
    case WordMotionTarget.NextWordEnd:
    case WordMotionTarget.PrevWordStart:
      return isWordBoundary(prev, next) && (!charIsWhitespace(prev) || charIsLineEnding(next));
    case WordMotionTarget.NextLongWordStart:
    case WordMotionTarget.PrevLongWordEnd:
      return isLongWordBoundary(prev, next) && (charIsLineEnding(next) || !charIsWhitespace(next));
    case WordMotionTarget.NextLongWordEnd:
    case WordMotionTarget.PrevLongWordStart:
      return isLongWordBoundary(prev, next) && (!charIsWhitespace(prev) || charIsLineEnding(next));
    case WordMotionTarget.NextSubWordStart:
      return (
        isSubWordBoundary(prev, next, Direction.Forward) &&
        (charIsLineEnding(next) || !(charIsWhitespace(next) || next === "_"))
      );
    case WordMotionTarget.PrevSubWordEnd:
      return (
        isSubWordBoundary(prev, next, Direction.Backward) &&
        (charIsLineEnding(next) || !(charIsWhitespace(next) || next === "_"))
      );
    case WordMotionTarget.NextSubWordEnd:
      return (
        isSubWordBoundary(prev, next, Direction.Forward) &&
        (!(charIsWhitespace(prev) || prev === "_") || charIsLineEnding(next))
      );
    case WordMotionTarget.PrevSubWordStart:
      return (
        isSubWordBoundary(prev, next, Direction.Backward) &&
        (!(charIsWhitespace(prev) || prev === "_") || charIsLineEnding(next))
      );
  }
}

// ---- Paragraphs ----

export function movePrevParagraph(
  doc: Doc,
  range: Range,
  count: number,
  behaviour: Movement,
): Range {
  let line = range.cursorLine(doc);
  const firstChar = doc.lineStart(line) === range.cursor(doc);
  const prevLineEmpty = isEmptyLine(doc, Math.max(0, line - 1));
  const currLineEmpty = isEmptyLine(doc, line);
  const prevEmptyToLine = prevLineEmpty && !currLineEmpty;

  // Skip the character before the paragraph boundary.
  if (prevEmptyToLine && !firstChar) line++;
  // The lines from `line` backwards, as Helix's reversed `lines_at` iterates them: the first is
  // the one before `line`.
  let cursor = line;
  const peek = () => (cursor > 0 ? isEmptyLine(doc, cursor - 1) : null);
  let lastLine = line;
  for (let i = 0; i < count; i++) {
    while (peek() === true) {
      cursor--;
      line--;
    }
    while (peek() === false) {
      cursor--;
      line--;
    }
    if (line === lastLine) break;
    lastLine = line;
  }

  const head = doc.lineStart(line);
  let anchor: number;
  if (behaviour === Movement.Move) {
    // Exclude the first character after the paragraph boundary.
    anchor = prevEmptyToLine && firstChar ? range.cursor(doc) : range.head;
  } else {
    anchor = range.putCursor(doc, head, true).anchor;
  }
  return new Range(anchor, head);
}

export function moveNextParagraph(
  doc: Doc,
  range: Range,
  count: number,
  behaviour: Movement,
): Range {
  let line = range.cursorLine(doc);
  const lastChar =
    prevGraphemeBoundary(doc, doc.lineStart(Math.min(line + 1, doc.lines))) === range.cursor(doc);
  const currLineEmpty = isEmptyLine(doc, line);
  const nextLineEmpty = isEmptyLine(doc, Math.min(doc.lines - 1, line + 1));
  const currEmptyToLine = currLineEmpty && !nextLineEmpty;

  // Skip the character after the paragraph boundary.
  if (currEmptyToLine && lastChar) line++;
  let cursor = line;
  const peek = () => (cursor < doc.lines ? isEmptyLine(doc, cursor) : null);
  let lastLine = line;
  for (let i = 0; i < count; i++) {
    while (peek() === false) {
      cursor++;
      line++;
    }
    while (peek() === true) {
      cursor++;
      line++;
    }
    if (line === lastLine) break;
    lastLine = line;
  }
  const head = doc.lineStart(line);
  let anchor: number;
  if (behaviour === Movement.Move) {
    anchor = currEmptyToLine && lastChar ? range.head : range.cursor(doc);
  } else {
    anchor = range.putCursor(doc, head, true).anchor;
  }
  return new Range(anchor, head);
}
