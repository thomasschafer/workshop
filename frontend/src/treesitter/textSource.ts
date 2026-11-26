import type { Text } from "@codemirror/state";
import type { Point } from "web-tree-sitter";

/** Read-only UTF-16 text source shared across parsing, injections, locals, and highlighting. */
export interface TextSource {
  readonly length: number;
  /**
   * Flat JS string for `web-tree-sitter`'s `Parser.parse`. Passing a string instead of a
   * `ParseCallback` lets `web-tree-sitter` use O(1) V8 SlicedStrings inside `node.text` during
   * query predicate evaluation (`#eq?`, `#any-of?`, `#match?`), which is ~4x faster than slicing a
   * CodeMirror rope on every predicate check.
   */
  readonly text: string;
  slice(from: number, to: number): string;
  pointAt(index: number): Point;
}

/** Computes a UTF-16 `Point` `{ row, column }` at `pos` in a CodeMirror `Text`. */
export function pointAtDoc(doc: Text, pos: number): Point {
  const clamped = Math.max(0, Math.min(pos, doc.length));
  const line = doc.lineAt(clamped);
  return { row: line.number - 1, column: clamped - line.from };
}

/** Advances `start` across `text` (counting `\n` boundaries in UTF-16 code units). */
export function advancePoint(start: Point, text: string): Point {
  const lastNewline = text.lastIndexOf("\n");
  if (lastNewline === -1) {
    return { row: start.row, column: start.column + text.length };
  }
  let lines = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) lines++;
  }
  return {
    row: start.row + lines,
    column: text.length - lastNewline - 1,
  };
}

/** Caches `doc.toString()` once per immutable CodeMirror `Text` instance across parse + highlights. */
const docTextCache = new WeakMap<Text, string>();

function cachedDocString(doc: Text): string {
  let str = docTextCache.get(doc);
  if (str === undefined) {
    str = doc.toString();
    docTextCache.set(doc, str);
  }
  return str;
}

/** Wraps a CodeMirror `Text` rope, caching its flat string once and answering `pointAt` in O(log N). */
export function textSourceFromDoc(doc: Text): TextSource {
  const text = cachedDocString(doc);
  return {
    length: doc.length,
    text,
    slice(from: number, to: number): string {
      return text.slice(from, to);
    },
    pointAt(index: number): Point {
      return pointAtDoc(doc, index);
    },
  };
}

/** Wraps a JS string with a lazily constructed line-start index (built only if `pointAt` is called). */
export function textSourceFromString(text: string): TextSource {
  let lineStarts: number[] | null = null;
  const ensureLineStarts = (): number[] => {
    if (lineStarts !== null) return lineStarts;
    const starts = [0];
    for (let i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) starts.push(i + 1);
    }
    lineStarts = starts;
    return starts;
  };
  return {
    length: text.length,
    text,
    slice(from: number, to: number): string {
      return text.slice(from, to);
    },
    pointAt(index: number): Point {
      const starts = ensureLineStarts();
      let lo = 0;
      let hi = starts.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >>> 1;
        if ((starts[mid] ?? 0) <= index) {
          lo = mid;
        } else {
          hi = mid;
        }
      }
      return { row: lo, column: index - (starts[lo] ?? 0) };
    },
  };
}

export type TextInput = string | Text | TextSource;

export function asTextSource(input: TextInput): TextSource {
  if (typeof input === "string") return textSourceFromString(input);
  if ("text" in input && "pointAt" in input) return input;
  return textSourceFromDoc(input);
}
