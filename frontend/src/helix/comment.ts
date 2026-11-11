// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's comment.rs.

import type { Change } from "./changes";
import { Range, Selection } from "./selection";
import { charIsWhitespace, type Doc, firstNonWhitespace } from "./text";

export const DEFAULT_COMMENT_TOKEN = "#";

export interface BlockCommentToken {
  readonly open: string;
  readonly close: string;
}

export const DEFAULT_BLOCK_TOKEN: BlockCommentToken = { open: "/*", close: "*/" };

/** The longest of `tokens` that `line` starts with, after its indentation. */
export function getCommentToken(doc: Doc, tokens: readonly string[], line: number): string | null {
  const start = firstNonWhitespace(doc, line);
  if (start === null) return null;
  const rest = doc.line(line).slice(start);
  let best: string | null = null;
  for (const token of tokens) {
    if (rest.startsWith(token) && (best === null || token.length > best.length)) best = token;
  }
  return best;
}

function findLineComment(
  token: string,
  doc: Doc,
  lines: Iterable<number>,
): { commented: boolean; toChange: number[]; min: number; margin: number } {
  let commented = true;
  const toChange: number[] = [];
  let min = Number.MAX_SAFE_INTEGER;
  let margin = 1;
  for (const line of lines) {
    const pos = firstNonWhitespace(doc, line);
    if (pos === null) continue;
    const text = doc.line(line);
    min = Math.min(min, pos);
    // As soon as one non-blank line isn't commented, none of them count as commented.
    if (text.slice(pos, pos + token.length) !== token) commented = false;
    // Uncomment with no margin if any token isn't followed by a space.
    if (text[pos + token.length] !== " ") margin = 0;
    toChange.push(line);
  }
  return { commented, toChange, min, margin };
}

export function toggleLineComments(doc: Doc, selection: Selection, token: string | null): Change[] {
  const tok = token ?? DEFAULT_COMMENT_TOKEN;
  const lines: number[] = [];
  let minNextLine = 0;
  for (const range of selection.ranges) {
    const [rawStart, end] = range.lineRange(doc);
    const start = Math.min(Math.max(rawStart, minNextLine), doc.lines);
    const stop = Math.min(end + 1, doc.lines);
    for (let l = start; l < stop; l++) lines.push(l);
    minNextLine = stop;
  }
  const { commented, toChange, min, margin } = findLineComment(tok, doc, lines);
  return toChange.map((line) => {
    const pos = doc.lineStart(line) + min;
    return commented
      ? { from: pos, to: pos + tok.length + margin, insert: "" }
      : { from: pos, to: pos, insert: `${tok} ` };
  });
}

type CommentChange =
  | {
      kind: "commented";
      range: Range;
      startPos: number;
      endPos: number;
      startMargin: boolean;
      endMargin: boolean;
      open: string;
      close: string;
    }
  | {
      kind: "uncommented";
      range: Range;
      startPos: number;
      endPos: number;
      open: string;
      close: string;
    }
  | { kind: "whitespace"; range: Range };

export function findBlockComments(
  tokens: readonly BlockCommentToken[],
  doc: Doc,
  selection: Selection,
): { commented: boolean; changes: CommentChange[] } {
  let commented = true;
  let onlyWhitespace = true;
  const changes: CommentChange[] = [];
  const defaults = tokens[0] ?? DEFAULT_BLOCK_TOKEN;
  // Longer tokens match first.
  const sorted = [...tokens].sort((a, b) =>
    a.open.length === b.open.length
      ? b.close.length - a.close.length
      : b.open.length - a.open.length,
  );
  for (const range of selection.ranges) {
    const text = range.fragment(doc);
    let startPos = -1;
    for (let i = 0; i < text.length; i++) {
      if (!charIsWhitespace(text.charAt(i))) {
        startPos = i;
        break;
      }
    }
    if (startPos === -1) {
      changes.push({ kind: "whitespace", range });
      continue;
    }
    let endPos = startPos;
    for (let i = text.length - 1; i >= 0; i--) {
      if (!charIsWhitespace(text.charAt(i))) {
        endPos = i;
        break;
      }
    }
    let lineCommented = false;
    let afterStart = 0;
    let beforeEnd = 0;
    let open = defaults.open;
    let close = defaults.close;
    const len = endPos + 1 - startPos;
    for (const token of sorted) {
      afterStart = startPos + token.open.length;
      beforeEnd = Math.max(0, endPos - token.close.length);
      if (len >= token.open.length + token.close.length) {
        if (
          text.slice(startPos, afterStart) === token.open &&
          text.slice(beforeEnd + 1, endPos + 1) === token.close
        ) {
          open = token.open;
          close = token.close;
          lineCommented = true;
          break;
        }
      }
    }
    if (!lineCommented) {
      changes.push({
        kind: "uncommented",
        range,
        startPos,
        endPos,
        open: defaults.open,
        close: defaults.close,
      });
      commented = false;
    } else {
      changes.push({
        kind: "commented",
        range,
        startPos,
        endPos,
        startMargin: text[afterStart] === " ",
        endMargin: afterStart !== beforeEnd && text[beforeEnd] === " ",
        open,
        close,
      });
    }
    onlyWhitespace = false;
  }
  if (onlyWhitespace) commented = false;
  return { commented, changes };
}

export function createBlockCommentTransaction(
  commented: boolean,
  commentChanges: readonly CommentChange[],
): { changes: Change[]; ranges: Range[] } {
  const changes: Change[] = [];
  const ranges: Range[] = [];
  let offs = 0;
  for (const change of commentChanges) {
    if (commented) {
      if (change.kind === "commented") {
        const from = change.range.from;
        changes.push({
          from: from + change.startPos,
          to: from + change.startPos + change.open.length + (change.startMargin ? 1 : 0),
          insert: "",
        });
        changes.push({
          from: from + change.endPos - change.close.length - (change.endMargin ? 1 : 0) + 1,
          to: from + change.endPos + 1,
          insert: "",
        });
      }
    } else if (change.kind === "uncommented") {
      const from = change.range.from;
      changes.push({
        from: from + change.startPos,
        to: from + change.startPos,
        insert: `${change.open} `,
      });
      changes.push({
        from: from + change.endPos + 1,
        to: from + change.endPos + 1,
        insert: ` ${change.close}`,
      });
      const offset = change.open.length + change.close.length + 2;
      ranges.push(
        new Range(from + offs, from + offs + change.endPos + 1 + offset).withDirection(
          change.range.direction,
        ),
      );
      offs += offset;
    } else {
      ranges.push(new Range(change.range.from + offs, change.range.to + offs));
    }
  }
  return { changes, ranges };
}

export function toggleBlockComments(
  doc: Doc,
  selection: Selection,
  tokens: readonly BlockCommentToken[],
): { changes: Change[]; selection: Selection | null } {
  const { commented, changes: found } = findBlockComments(tokens, doc, selection);
  const { changes, ranges } = createBlockCommentTransaction(commented, found);
  return {
    changes,
    selection: commented ? null : new Selection(ranges, selection.primaryIndex),
  };
}

/** Each line the selection covers, as a range including its line ending. */
export function splitLinesOfSelection(doc: Doc, selection: Selection): Selection {
  const ranges: Range[] = [];
  for (const range of selection.ranges) {
    const [start, end] = range.lineRange(doc);
    for (let line = start; line <= end; line++) {
      ranges.push(new Range(doc.lineStart(line), doc.lineStart(Math.min(line + 1, doc.lines))));
    }
  }
  return new Selection(ranges, 0);
}
