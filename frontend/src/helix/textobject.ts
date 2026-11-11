// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's textobject.rs,
// surround.rs, match_brackets.rs and search.rs, without tree-sitter, as Helix behaves in a file
// with no syntax tree.

import { Direction, Range, type Selection } from "./selection";
import {
  CharCategory,
  categorizeChar,
  charIsInlineWhitespace,
  type Doc,
  isEmptyLine,
  nextGraphemeBoundary,
  prevGraphemeBoundary,
} from "./text";

export enum TextObject {
  Around,
  Inside,
}

function findWordBoundary(doc: Doc, start: number, direction: Direction, long: boolean): number {
  const s = doc.str;
  let pos = start;
  let prevCategory: CharCategory;
  if (direction === Direction.Forward) {
    prevCategory = pos === 0 ? CharCategory.Whitespace : categorizeChar(s.charAt(pos - 1));
  } else {
    prevCategory = pos === s.length ? CharCategory.Whitespace : categorizeChar(s.charAt(pos));
  }
  // Iterates from `start` forwards, or from the character before it backwards.
  let i = start;
  for (;;) {
    let ch: string;
    if (direction === Direction.Forward) {
      if (i >= s.length) break;
      ch = s.charAt(i++);
    } else {
      if (i <= 0) break;
      ch = s.charAt(--i);
    }
    const category = categorizeChar(ch);
    if (category === CharCategory.Eol || category === CharCategory.Whitespace) return pos;
    if (!long && category !== prevCategory && pos !== 0 && pos !== s.length) return pos;
    pos = direction === Direction.Forward ? pos + 1 : Math.max(0, pos - 1);
    prevCategory = category;
  }
  return pos;
}

export function textobjectWord(
  doc: Doc,
  range: Range,
  textobject: TextObject,
  long: boolean,
): Range {
  const pos = range.cursor(doc);
  const wordStart = findWordBoundary(doc, pos, Direction.Backward, long);
  const ch = doc.char(pos);
  const category = ch === undefined ? null : categorizeChar(ch);
  const wordEnd =
    category === null || category === CharCategory.Whitespace || category === CharCategory.Eol
      ? pos
      : findWordBoundary(doc, pos + 1, Direction.Forward, long);

  if (wordStart === wordEnd) return new Range(wordStart, wordEnd);
  if (textobject === TextObject.Inside) return new Range(wordStart, wordEnd);

  let right = 0;
  while (wordEnd + right < doc.length && charIsInlineWhitespace(doc.str.charAt(wordEnd + right)))
    right++;
  if (right > 0) return new Range(wordStart, wordEnd + right);
  let left = 0;
  while (wordStart - left - 1 >= 0 && charIsInlineWhitespace(doc.str.charAt(wordStart - left - 1)))
    left++;
  return new Range(wordStart - left, wordEnd);
}

export function textobjectParagraph(
  doc: Doc,
  range: Range,
  textobject: TextObject,
  count: number,
): Range {
  let line = range.cursorLine(doc);
  const prevLineEmpty = isEmptyLine(doc, Math.max(0, line - 1));
  const currLineEmpty = isEmptyLine(doc, line);
  const nextLineEmpty = line + 1 >= doc.lines || isEmptyLine(doc, line + 1);
  const lastChar =
    prevGraphemeBoundary(doc, doc.lineStart(Math.min(line + 1, doc.lines))) === range.cursor(doc);
  const prevEmptyToLine = prevLineEmpty && !currLineEmpty;
  const currEmptyToLine = currLineEmpty && !nextLineEmpty;

  // Lines before `from`, latest first, as Helix's reversed `lines_at(from)` gives them.
  const backwards = (from: number) => {
    let cursor = from;
    return {
      peek: () => (cursor > 0 ? isEmptyLine(doc, cursor - 1) : null),
      next: () => {
        cursor--;
      },
    };
  };

  // Skip the character before the paragraph boundary.
  let lineBack = line;
  if (prevEmptyToLine || currEmptyToLine) lineBack++;
  // Don't include the current paragraph at its end; include the next.
  if (!(currEmptyToLine && lastChar)) {
    const lines = backwards(lineBack);
    while (lines.peek() === true) {
      lines.next();
      lineBack--;
    }
    while (lines.peek() === false) {
      lines.next();
      lineBack--;
    }
  }

  // Skip the character after the paragraph boundary.
  if (currEmptyToLine && lastChar) line++;
  let cursor = line;
  const peek = () => (cursor < doc.lines ? isEmptyLine(doc, cursor) : null);
  let countDone = 0;
  for (let i = 0; i < count; i++) {
    let done = false;
    while (peek() === false) {
      cursor++;
      line++;
      done = true;
    }
    while (peek() === true) {
      cursor++;
      line++;
    }
    if (done) countDone++;
  }

  // Search a paragraph backwards for the last paragraph, so `map` at the end of a paragraph with
  // trailing blank lines is useful.
  const lastParagraph = countDone !== count && peek() === null;
  if (lastParagraph) {
    const lines = backwards(lineBack);
    while (lines.peek() === true) {
      lines.next();
      lineBack--;
    }
    while (lines.peek() === false) {
      lines.next();
      lineBack--;
    }
  }

  if (textobject === TextObject.Inside) {
    // Remove the last blank lines.
    const lines = backwards(line);
    while (lines.peek() === true) {
      lines.next();
      line--;
    }
  }

  return new Range(doc.lineStart(lineBack), doc.lineStart(line));
}

export function textobjectPairSurround(
  doc: Doc,
  range: Range,
  textobject: TextObject,
  ch: string,
  findType: FindType,
  count: number,
): Range {
  const pos = findNthPairsPos(doc, ch, range, findType, count);
  return pos instanceof SurroundError ? range : pairRange(doc, pos, textobject);
}

export function textobjectPairSurroundClosest(
  doc: Doc,
  range: Range,
  textobject: TextObject,
  count: number,
): Range {
  const pos = findNthClosestPairsPos(doc, range, count);
  return pos instanceof SurroundError ? range : pairRange(doc, pos, textobject);
}

function pairRange(doc: Doc, [anchor, head]: [number, number], textobject: TextObject): Range {
  if (textobject === TextObject.Inside) {
    return anchor < head
      ? new Range(nextGraphemeBoundary(doc, anchor), head)
      : new Range(anchor, nextGraphemeBoundary(doc, head));
  }
  return anchor < head
    ? new Range(anchor, nextGraphemeBoundary(doc, head))
    : new Range(nextGraphemeBoundary(doc, anchor), head);
}

// ---- Brackets ----

const MAX_PLAINTEXT_SCAN = 10_000;

export const BRACKETS: readonly (readonly [string, string])[] = [
  ["(", ")"],
  ["{", "}"],
  ["[", "]"],
  ["<", ">"],
  ["‘", "’"],
  ["“", "”"],
  ["«", "»"],
  ["「", "」"],
  ["（", "）"],
];

/** Every bracket, and the pairs that open and close with the same character. */
const PAIRS: readonly (readonly [string, string])[] = [
  ...BRACKETS,
  ['"', '"'],
  ["'", "'"],
  ["`", "`"],
  ["|", "|"],
];

/** The open and close characters of the pair `ch` belongs to, or `ch` twice. */
export function getPair(ch: string): [string, string] {
  const pair = PAIRS.find(([open, close]) => open === ch || close === ch);
  return pair ? [pair[0], pair[1]] : [ch, ch];
}

export function isOpenBracket(ch: string): boolean {
  return BRACKETS.some(([open]) => open === ch);
}

export function isCloseBracket(ch: string): boolean {
  return BRACKETS.some(([, close]) => close === ch);
}

function isValidBracket(ch: string): boolean {
  return BRACKETS.some(([open, close]) => open === ch || close === ch);
}

/** The bracket matching the one at `pos`, ignoring syntax. */
export function findMatchingBracketPlaintext(doc: Doc, pos: number): number | null {
  const bracket = doc.char(pos);
  if (bracket === undefined || !isValidBracket(bracket)) return null;
  const [open, close] = getPair(bracket);
  const matching = open === bracket ? close : open;
  const forward = isOpenBracket(bracket);
  let depth = 1;
  for (let i = 0; i < MAX_PLAINTEXT_SCAN; i++) {
    const p = forward ? pos + 1 + i : pos - 1 - i;
    const candidate = doc.char(p);
    if (candidate === undefined) return null;
    if (candidate === bracket) {
      depth++;
    } else if (candidate === matching) {
      if (depth === 1) return p;
      depth--;
    }
  }
  return null;
}

/**
 * The bracket matching the one at `pos` or, away from brackets, the one closing the innermost
 * pair around it. Helix finds that pair from the syntax tree; this finds it in the plain text.
 */
export function findMatchingBracketFuzzy(doc: Doc, pos: number): number | null {
  const ch = doc.char(pos);
  if (ch !== undefined && isValidBracket(ch)) return findMatchingBracketPlaintext(doc, pos);
  const pair = findNthClosestPairsPlain(doc, Range.point(pos), 1);
  return pair instanceof SurroundError ? null : Math.max(pair[0], pair[1]);
}

/** Helix's `search::find_nth_char`, from the gap at `pos`. */
export function findNthChar(
  n: number,
  doc: Doc,
  matches: string | ((ch: string) => boolean),
  start: number,
  direction: Direction,
): number | null {
  if (n === 0 || start < 0 || start > doc.length) return null;
  const test = typeof matches === "string" ? (c: string) => c === matches : matches;
  let remaining = n;
  if (direction === Direction.Forward) {
    for (let pos = start; pos < doc.length; pos++) {
      if (test(doc.str.charAt(pos)) && --remaining === 0) return pos;
    }
  } else {
    for (let pos = start - 1; pos >= 0; pos--) {
      if (test(doc.str.charAt(pos)) && --remaining === 0) return pos;
    }
  }
  return null;
}

// ---- Surround ----

export class SurroundError {
  constructor(readonly message: string) {}

  static pairNotFound = new SurroundError("Surround pair not found around all cursors");
  static cursorOverlap = new SurroundError("Cursors overlap for a single surround pair range");
  static rangeExceedsText = new SurroundError("Cursor range exceeds text length");
  static ambiguous = new SurroundError("Cursor on ambiguous surround pair");
}

export enum FindType {
  Surround,
  Next,
  Prev,
}

/** The closest pair of brackets enclosing the range, as `(anchor, head)` in its direction. */
export function findNthClosestPairsPos(
  doc: Doc,
  range: Range,
  skip: number,
): [number, number] | SurroundError {
  return findNthClosestPairsPlain(doc, range, skip);
}

function findNthClosestPairsPlain(
  doc: Doc,
  range: Range,
  initialSkip: number,
): [number, number] | SurroundError {
  let skip = initialSkip;
  const stack: string[] = [];
  const pos = range.from;
  let closePos = pos - 1;
  for (let i = pos; i < doc.length; i++) {
    const ch = doc.str.charAt(i);
    closePos++;
    if (isOpenBracket(ch)) {
      // Step over the close pairs of open pairs found after the cursor, to find a lone close
      // pair whose open pair is before it.
      stack.push(ch);
      continue;
    }
    if (!isCloseBracket(ch)) continue;
    const [open, close] = getPair(ch);
    if (stack[stack.length - 1] === open) {
      stack.pop();
      continue;
    }
    const openPos = findNthOpenPair(doc, open, close, closePos, 1);
    // The pair must enclose the range, not just the cursor.
    if (openPos !== null && openPos <= pos + 1 && closePos >= Math.max(0, range.to - 1)) {
      if (skip > 1) {
        skip--;
        continue;
      }
      return range.direction === Direction.Forward ? [openPos, closePos] : [closePos, openPos];
    }
  }
  return SurroundError.pairNotFound;
}

/**
 * The pair of `ch`, which may open or close it, around the range's cursor, or the next or
 * previous one. `n` skips `n - 1` pairs.
 */
export function findNthPairsPos(
  doc: Doc,
  ch: string,
  range: Range,
  findType: FindType,
  n: number,
): [number, number] | SurroundError {
  if (doc.length < 2) return SurroundError.pairNotFound;
  if (range.to > doc.length) return SurroundError.rangeExceedsText;

  const [open, close] = getPair(ch);
  let pos = range.cursor(doc);
  let count = n;
  if (findType === FindType.Next) {
    const next = findNthChar(n, doc, open, pos, Direction.Forward);
    if (next === null) return SurroundError.pairNotFound;
    pos = next + 1;
    count = 1;
  } else if (findType === FindType.Prev) {
    const prev = findNthChar(n, doc, close, pos, Direction.Backward);
    if (prev === null) return SurroundError.pairNotFound;
    if (prev === 0) return SurroundError.pairNotFound;
    pos = prev - 1;
    count = 1;
  }

  let openPos: number | null;
  let closePos: number | null;
  if (open === close) {
    if (doc.char(pos) === open) {
      // On a character that both opens and closes, such as `"`, which side to search is
      // ambiguous.
      const matching = findMatchingBracketPlaintext(doc, pos);
      if (matching === null) return SurroundError.ambiguous;
      [openPos, closePos] = matching > pos ? [pos, matching] : [matching, pos];
    } else {
      openPos = findNthChar(count, doc, open, pos, Direction.Backward);
      closePos = findNthChar(count, doc, close, pos, Direction.Forward);
    }
  } else {
    openPos = findNthOpenPair(doc, open, close, pos, count);
    closePos = findNthClosePair(doc, open, close, pos, count);
  }
  if (openPos === null || closePos === null) return SurroundError.pairNotFound;
  return range.direction === Direction.Forward ? [openPos, closePos] : [closePos, openPos];
}

function findNthOpenPair(
  doc: Doc,
  open: string,
  close: string,
  start: number,
  n: number,
): number | null {
  if (start >= doc.length) return null;
  let pos = start;
  // Iterates backwards from just after `start`, so a cursor on the open character finds it.
  let i = start + 1;
  const prev = () => (i > 0 ? doc.str.charAt(--i) : undefined);
  if (prev() === open) return pos;
  for (let k = 0; k < n; k++) {
    let stepOver = 0;
    for (;;) {
      const c = prev();
      if (c === undefined) return null;
      pos = Math.max(0, pos - 1);
      // Ignore pairs enclosed within the search.
      if (c === close) {
        stepOver++;
      } else if (c === open) {
        if (stepOver === 0) break;
        stepOver = Math.max(0, stepOver - 1);
      }
    }
  }
  return pos;
}

function findNthClosePair(
  doc: Doc,
  open: string,
  close: string,
  start: number,
  n: number,
): number | null {
  if (start >= doc.length) return null;
  let pos = start;
  let i = start;
  const next = () => (i < doc.length ? doc.str.charAt(i++) : undefined);
  if (next() === close) return pos;
  for (let k = 0; k < n; k++) {
    let stepOver = 0;
    for (;;) {
      const c = next();
      if (c === undefined) return null;
      pos++;
      if (c === open) {
        stepOver++;
      } else if (c === close) {
        if (stepOver === 0) break;
        stepOver = Math.max(0, stepOver - 1);
      }
    }
  }
  return pos;
}

/**
 * The positions of the surrounding pairs around every range, flattened as open then close for
 * each, or an error if any can't be found or two ranges share a pair.
 */
export function getSurroundPos(
  doc: Doc,
  selection: Selection,
  ch: string | null,
  skip: number,
): number[] | SurroundError {
  const out: number[] = [];
  for (const range of selection.ranges) {
    const raw =
      ch === null
        ? findNthClosestPairsPos(doc, range, skip)
        : findNthPairsPos(doc, ch, range, FindType.Surround, skip);
    if (raw instanceof SurroundError) return raw;
    const pair = new Range(raw[0], raw[1]);
    const openPos = pair.from;
    const closePos = pair.to;
    if (out.includes(openPos) || out.includes(closePos)) return SurroundError.cursorOverlap;
    out.push(Math.min(openPos, closePos), Math.max(openPos, closePos));
  }
  return out;
}
