// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's chars.rs, graphemes.rs
// and line_ending.rs.

import { findClusterBreak, Text } from "@codemirror/state";

/**
 * A document's text, with the lookups Helix's commands make. Positions are offsets in UTF-16
 * code units, as CodeMirror's are, where Helix counts `char`s; the two only differ for characters
 * outside the Basic Multilingual Plane, which are kept whole by moving between graphemes.
 *
 * Lines are 0-based, as in Helix. CodeMirror separates lines with `\n` alone, so every line ending
 * is one code unit long.
 */
export class Doc {
  readonly str: string;

  constructor(readonly text: Text) {
    this.str = text.toString();
  }

  static of(str: string): Doc {
    return new Doc(Text.of(str.split("\n")));
  }

  get length(): number {
    return this.str.length;
  }

  /** How many lines there are, counting the empty one after a final line ending. */
  get lines(): number {
    return this.text.lines;
  }

  /** The code unit at `pos`, or undefined past the end. */
  char(pos: number): string | undefined {
    return pos >= 0 && pos < this.str.length ? this.str[pos] : undefined;
  }

  lineOf(pos: number): number {
    this.check(pos);
    return this.text.lineAt(pos).number - 1;
  }

  /** Where `line` starts. One past the last line, this is the end of the document. */
  lineStart(line: number): number {
    if (line === this.lines) return this.length;
    return this.text.line(this.lineNumber(line)).from;
  }

  /** Where `line`'s line ending starts, or the end of the document on the last line. */
  lineEnd(line: number): number {
    return this.text.line(this.lineNumber(line)).to;
  }

  /** `line`, including its line ending. */
  line(line: number): string {
    const start = this.lineStart(line);
    const next = line + 1 < this.lines ? this.lineStart(line + 1) : this.length;
    return this.str.slice(start, next);
  }

  slice(from: number, to: number): string {
    return this.str.slice(from, to);
  }

  private lineNumber(line: number): number {
    if (!Number.isInteger(line) || line < 0 || line >= this.lines) {
      throw new RangeError(`line ${line} is outside a document of ${this.lines} lines`);
    }
    return line + 1;
  }

  private check(pos: number): void {
    if (!Number.isInteger(pos) || pos < 0 || pos > this.length) {
      throw new RangeError(`position ${pos} is outside a document of length ${this.length}`);
    }
  }
}

/** The element at `i`, which must exist. */
export function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) throw new RangeError(`index ${i} is outside ${items.length} items`);
  return item;
}

// ---- Graphemes ----

export function nextGraphemeBoundary(doc: Doc, pos: number): number {
  if (pos >= doc.length) return doc.length;
  return findClusterBreak(doc.str, pos, true);
}

export function prevGraphemeBoundary(doc: Doc, pos: number): number {
  if (pos <= 0) return 0;
  return findClusterBreak(doc.str, pos, false);
}

export function nthNextGraphemeBoundary(doc: Doc, pos: number, n: number): number {
  let p = pos;
  for (let i = 0; i < n; i++) p = nextGraphemeBoundary(doc, p);
  return p;
}

export function nthPrevGraphemeBoundary(doc: Doc, pos: number, n: number): number {
  let p = pos;
  for (let i = 0; i < n; i++) p = prevGraphemeBoundary(doc, p);
  return p;
}

export function isGraphemeBoundary(doc: Doc, pos: number): boolean {
  if (pos <= 0 || pos >= doc.length) return true;
  return nextGraphemeBoundary(doc, prevGraphemeBoundary(doc, pos)) === pos;
}

export function ensureGraphemeBoundaryNext(doc: Doc, pos: number): number {
  return isGraphemeBoundary(doc, pos) ? pos : nextGraphemeBoundary(doc, pos);
}

export function ensureGraphemeBoundaryPrev(doc: Doc, pos: number): number {
  return isGraphemeBoundary(doc, pos) ? pos : prevGraphemeBoundary(doc, pos);
}

/** The graphemes of `str`, in order. */
export function graphemes(str: string): string[] {
  const out: string[] = [];
  for (let pos = 0; pos < str.length; ) {
    const next = findClusterBreak(str, pos, true);
    out.push(str.slice(pos, next));
    pos = next;
  }
  return out;
}

// ---- Characters ----

export enum CharCategory {
  Whitespace,
  Eol,
  Word,
  Punctuation,
  Unknown,
}

const WORD = /^[\p{Alphabetic}\p{N}_]$/u;
const ALPHANUMERIC = /^[\p{Alphabetic}\p{N}]$/u;
const PUNCTUATION = /^[\p{P}\p{Sm}\p{Sc}\p{Sk}]$/u;
const WHITESPACE = /^\p{White_Space}$/u;
const UPPERCASE = /^\p{Uppercase}$/u;
const LOWERCASE = /^\p{Lowercase}$/u;

export function charIsLineEnding(ch: string): boolean {
  return ch === "\n" || ch === "\r";
}

/** Rust's `char::is_whitespace`, which counts line endings as whitespace. */
export function charIsWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n" || ch === "\r" || WHITESPACE.test(ch);
}

/** Helix's `char_is_whitespace`: whitespace that doesn't end a line. */
export function charIsInlineWhitespace(ch: string): boolean {
  if (ch === " " || ch === "\t") return true;
  const code = ch.codePointAt(0) ?? 0;
  return (
    code === 0xa0 ||
    code === 0x180e ||
    code === 0x202f ||
    code === 0x205f ||
    code === 0x3000 ||
    code === 0xfeff ||
    (code >= 0x2000 && code <= 0x200b)
  );
}

export function charIsWord(ch: string): boolean {
  if (ch.length === 1) {
    const c = ch.charCodeAt(0);
    if (c < 128) {
      return (
        (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 // _
      );
    }
  }
  return WORD.test(ch);
}

export function charIsAlphanumeric(ch: string): boolean {
  return ch !== "_" && (charIsWord(ch) || ALPHANUMERIC.test(ch));
}

export function charIsPunctuation(ch: string): boolean {
  return PUNCTUATION.test(ch);
}

export function charIsUppercase(ch: string): boolean {
  return UPPERCASE.test(ch);
}

export function charIsLowercase(ch: string): boolean {
  return LOWERCASE.test(ch);
}

export function categorizeChar(ch: string): CharCategory {
  if (charIsLineEnding(ch)) return CharCategory.Eol;
  if (charIsWhitespace(ch)) return CharCategory.Whitespace;
  if (charIsWord(ch)) return CharCategory.Word;
  if (charIsPunctuation(ch)) return CharCategory.Punctuation;
  return CharCategory.Unknown;
}

/** The character (code point) starting at `pos`, which may be two code units long. */
export function codePointAt(doc: Doc, pos: number): string | undefined {
  const code = doc.str.codePointAt(pos);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

/** Whether `line` (including its line ending) is empty apart from its line ending. */
export function isEmptyLine(doc: Doc, line: number): boolean {
  return doc.lineEnd(line) === doc.lineStart(line);
}

/** The offset of the first character in `line` that isn't whitespace, if there is one. */
export function firstNonWhitespace(doc: Doc, line: number): number | null {
  const start = doc.lineStart(line);
  const end = doc.lineEnd(line);
  for (let pos = start; pos < end; pos++) {
    if (!charIsWhitespace(doc.str.charAt(pos))) return pos - start;
  }
  return null;
}

/** Helix's `movement::skip_while`: the first position from `pos` where `f` fails. */
export function skipWhile(doc: Doc, pos: number, f: (ch: string) => boolean): number | null {
  for (let p = pos; p < doc.length; p++) {
    if (!f(doc.str.charAt(p))) return p;
  }
  return null;
}

/** Helix's `movement::backwards_skip_while`. */
export function backwardsSkipWhile(
  doc: Doc,
  pos: number,
  f: (ch: string) => boolean,
): number | null {
  for (let i = 0; pos - i - 1 >= 0; i++) {
    if (!f(doc.str.charAt(pos - i - 1))) return pos - i;
  }
  return null;
}
