// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-term's commands.rs.

import {
  type Change,
  changeByAndWithSelection,
  deleteByAndWithSelection,
  deletions,
  mapRange,
} from "./changes";
import { STATIC_COMMANDS, TYPABLE_COMMANDS } from "./commandList";
import {
  type BlockCommentToken,
  createBlockCommentTransaction,
  DEFAULT_BLOCK_TOKEN,
  findBlockComments,
  getCommentToken,
  splitLinesOfSelection,
  toggleBlockComments,
  toggleLineComments,
} from "./comment";
import { type HelixEditor, type HostAction, IndentStyleKind } from "./editor";
import { incrementInteger } from "./increment";
import type { MappableCommand, Mode } from "./keymap";
import { KEY, type Key, keyCharWithModifiers, parseMacro, unparseKey } from "./keys";
import {
  Movement,
  moveHorizontally,
  moveNextParagraph,
  movePrevParagraph,
  moveVertically,
  posAtVisualColumn,
  visualColumn,
  WordMotionTarget,
  wordMove,
} from "./movement";
import type { PickerItem } from "./picker";
import { buildRegex, escapeRegex } from "./regex";
import {
  Direction,
  findAll,
  keepOrRemoveMatches,
  Range,
  Selection,
  selectOnMatches,
  splitOnMatches,
  splitOnNewline,
} from "./selection";
import {
  at,
  backwardsSkipWhile,
  charIsAlphanumeric,
  charIsLowercase,
  charIsUppercase,
  charIsWhitespace,
  charIsWord,
  type Doc,
  ensureGraphemeBoundaryNext,
  ensureGraphemeBoundaryPrev,
  firstNonWhitespace,
  graphemes,
  nextGraphemeBoundary,
  nthNextGraphemeBoundary,
  nthPrevGraphemeBoundary,
  prevGraphemeBoundary,
  skipWhile,
} from "./text";
import {
  FindType,
  findMatchingBracketFuzzy,
  findNthChar,
  getPair,
  getSurroundPos,
  SurroundError,
  TextObject,
  textobjectPairSurround,
  textobjectPairSurroundClosest,
  textobjectParagraph,
  textobjectWord,
} from "./textobject";

export type OnKeyKind = "fallback" | "pseudoPending";

/** What a command runs with: the editor, and the count and register given before it. */
export interface Context {
  readonly editor: HelixEditor;
  /** The count typed before the command, if one was. */
  count: number | null;
  register: string | null;
  /** Waits for the next key, which goes to `callback` instead of the keymap. */
  onNextKey(callback: (cx: Context, key: Key) => void | Promise<void>, kind?: OnKeyKind): void;
  /** Runs keys as if they'd been typed, for macros. Only call this from a deferred function. */
  feedKeys(keys: readonly Key[]): Promise<void>;
  /** Runs `f` once the key being handled is done, as Helix runs a command's callbacks. */
  defer(f: () => Promise<void>): void;
  /** Runs a command line, as typed after `:`. */
  runCommandLine(line: string): Promise<void>;
  /** Runs a command, as if its keys were pressed. */
  runCommand(command: MappableCommand): Promise<void>;
  /** Shows a list to pick from, whose items run with this command's count and register. */
  openPicker(title: string, items: readonly PickerItem[]): void;
  /** The keys bound to each command in the current mode, by command name. */
  bindings(): ReadonlyMap<string, readonly string[]>;
}

export type CommandFn = (cx: Context) => void | Promise<void>;

/** The count, or 1 if none was given. */
export function count(cx: Context): number {
  return cx.count ?? 1;
}

function transform(cx: Context, f: (range: Range, doc: Doc) => Range): void {
  const doc = cx.editor.doc;
  cx.editor.setSelection(cx.editor.selection.transform((r) => f(r, doc)));
}

function isSelect(cx: Context): boolean {
  return cx.editor.mode === "select";
}

function behaviour(cx: Context): Movement {
  return isSelect(cx) ? Movement.Extend : Movement.Move;
}

/** Runs a motion, which `A-.` can repeat. */
function applyMotion(cx: Context, motion: (editor: HelixEditor) => void): void {
  motion(cx.editor);
  cx.editor.lastMotion = motion;
}

function defaultYankRegister(cx: Context): string {
  return cx.register ?? '"';
}

// ---- Moving ----

function moveImpl(
  cx: Context,
  dir: Direction,
  movement: Movement,
  vertical: "none" | "line" | "visual",
): void {
  const n = count(cx);
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection.transform((range) => {
    if (vertical === "none") return moveHorizontally(doc, range, dir, n, movement);
    if (vertical === "visual" && editor.host.softWrap()) {
      return moveVisual(editor, doc, range, dir, n, movement);
    }
    return moveVertically(doc, range, dir, n, movement, editor.tabWidth);
  });
  if (n > 1) editor.pushJump();
  editor.setSelection(selection);
}

function moveVisual(
  editor: HelixEditor,
  doc: Doc,
  range: Range,
  dir: Direction,
  n: number,
  movement: Movement,
): Range {
  let pos = range.cursor(doc);
  let goal = range.goalColumn;
  for (let i = 0; i < n; i++) {
    const next = editor.host.moveVisually(pos, dir === Direction.Forward, goal);
    if (next === null) return moveVertically(doc, range, dir, n, movement, editor.tabWidth);
    pos = next.pos;
    goal = next.goal;
  }
  // Avoid extending to the end of the last, empty line.
  if (movement === Movement.Extend && doc.line(doc.lineOf(pos)).length === 0) return range;
  return range.putCursor(doc, pos, movement === Movement.Extend).withGoalColumn(goal);
}

function gotoLineEndImpl(cx: Context, movement: Movement): void {
  transform(cx, (range, doc) => {
    const line = range.cursorLine(doc);
    const lineStart = doc.lineStart(line);
    const pos = Math.max(prevGraphemeBoundary(doc, doc.lineEnd(line)), lineStart);
    return range.putCursor(doc, pos, movement === Movement.Extend);
  });
}

function gotoLineEndNewlineImpl(cx: Context, movement: Movement): void {
  transform(cx, (range, doc) =>
    range.putCursor(doc, doc.lineEnd(range.cursorLine(doc)), movement === Movement.Extend),
  );
}

function gotoLineStartImpl(cx: Context, movement: Movement): void {
  transform(cx, (range, doc) =>
    range.putCursor(doc, doc.lineStart(range.cursorLine(doc)), movement === Movement.Extend),
  );
}

function gotoFirstNonwhitespaceImpl(cx: Context, movement: Movement): void {
  transform(cx, (range, doc) => {
    const line = range.cursorLine(doc);
    const pos = firstNonWhitespace(doc, line);
    return pos === null
      ? range
      : range.putCursor(doc, doc.lineStart(line) + pos, movement === Movement.Extend);
  });
}

function moveWordImpl(cx: Context, target: WordMotionTarget): void {
  const n = count(cx);
  transform(cx, (range, doc) => wordMove(doc, range, n, target));
}

function extendWordImpl(cx: Context, target: WordMotionTarget): void {
  const n = count(cx);
  transform(cx, (range, doc) => {
    const word = wordMove(doc, range, n, target);
    return range.putCursor(doc, word.cursor(doc), true);
  });
}

function gotoParaImpl(
  cx: Context,
  f: (doc: Doc, range: Range, count: number, behaviour: Movement) => Range,
): void {
  const n = count(cx);
  applyMotion(cx, (editor) => {
    const doc = editor.doc;
    const b = editor.mode === "select" ? Movement.Extend : Movement.Move;
    const selection = editor.selection.transform((r) => f(doc, r, n, b));
    editor.pushJump();
    editor.setSelection(selection);
  });
}

function gotoFileStartImpl(cx: Context, movement: Movement): void {
  if (cx.count !== null) {
    gotoLineImpl(cx, movement);
    return;
  }
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection.transform((r) =>
    r.putCursor(doc, 0, movement === Movement.Extend),
  );
  editor.pushJump();
  editor.setSelection(selection);
}

function gotoFileEndImpl(cx: Context, movement: Movement): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection.transform((r) =>
    r.putCursor(doc, doc.length, movement === Movement.Extend),
  );
  editor.pushJump();
  editor.setSelection(selection);
}

function gotoLineImpl(cx: Context, movement: Movement): void {
  if (cx.count === null) return;
  cx.editor.pushJump();
  gotoLineWithoutJumplist(cx.editor, cx.count, movement);
}

export function gotoLineWithoutJumplist(
  editor: HelixEditor,
  line: number,
  movement: Movement,
): void {
  const doc = editor.doc;
  // If the last line is blank, don't jump to it.
  const maxLine = doc.line(doc.lines - 1).length === 0 ? Math.max(0, doc.lines - 2) : doc.lines - 1;
  const lineIdx = Math.min(line - 1, maxLine);
  const pos = doc.lineStart(lineIdx);
  editor.setSelection(
    editor.selection.transform((r) => r.putCursor(doc, pos, movement === Movement.Extend)),
  );
}

function gotoLastLineImpl(cx: Context, movement: Movement): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const lineIdx = doc.line(doc.lines - 1).length === 0 ? Math.max(0, doc.lines - 2) : doc.lines - 1;
  const pos = doc.lineStart(lineIdx);
  const selection = editor.selection.transform((r) =>
    r.putCursor(doc, pos, movement === Movement.Extend),
  );
  editor.pushJump();
  editor.setSelection(selection);
}

function gotoColumnImpl(cx: Context, movement: Movement): void {
  const n = count(cx);
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection.transform((range) => {
    const line = range.cursorLine(doc);
    const lineStart = doc.lineStart(line);
    const lineEnd = doc.lineEnd(line);
    const pos = Math.min(nthNextGraphemeBoundary(doc, lineStart, n - 1), lineEnd);
    return range.putCursor(doc, pos, movement === Movement.Extend);
  });
  editor.pushJump();
  editor.setSelection(selection);
}

function gotoWindow(cx: Context, align: "top" | "center" | "bottom"): void {
  const n = count(cx) - 1;
  const editor = cx.editor;
  const { firstLine, lastLine, height } = editor.host.viewport();
  const scrolloff = Math.min(editor.options.scrolloff, Math.floor(Math.max(0, height - 1) / 2));
  const lastVisual = lastLine - firstLine;
  let line: number;
  if (align === "top") line = firstLine + scrolloff + n;
  else if (align === "center") line = firstLine + Math.floor(lastVisual / 2);
  else line = firstLine + Math.max(0, lastVisual - (scrolloff + n));
  line = Math.min(
    Math.max(line, firstLine + scrolloff),
    firstLine + Math.max(0, lastVisual - scrolloff),
  );
  const doc = editor.doc;
  const pos = doc.lineStart(Math.min(line, doc.lines - 1));
  editor.setSelection(editor.selection.transform((r) => r.putCursor(doc, pos, isSelect(cx))));
}

/** Scrolls by `offset` lines, moving the cursor along or keeping it in view. */
function scroll(cx: Context, offset: number, direction: Direction, syncCursor: boolean): void {
  const editor = cx.editor;
  if (offset > 3) editor.pushJump();
  const doc = editor.doc;
  const { firstLine, height } = editor.host.viewport();
  const signed = direction === Direction.Forward ? offset : -offset;
  const newFirst = Math.min(Math.max(0, firstLine + signed), Math.max(0, doc.lines - 1));
  editor.host.scroll({ kind: "lines", lines: newFirst - firstLine });
  if (syncCursor) {
    const movement = behaviour(cx);
    const selection = editor.selection.transform((range) =>
      editor.host.softWrap()
        ? moveVisual(editor, doc, range, direction, offset, movement)
        : moveVertically(doc, range, direction, offset, movement, editor.tabWidth),
    );
    editor.setSelection(selection);
    return;
  }
  const range = editor.selection.primary;
  const cursor = range.cursor(doc);
  const scrolloff = Math.min(editor.options.scrolloff, Math.floor(Math.max(0, height - 1) / 2));
  let head: number;
  if (direction === Direction.Forward) {
    const line = Math.min(newFirst + scrolloff, doc.lines - 1);
    head = doc.lineStart(line);
    if (head <= cursor) return;
  } else {
    const line = Math.min(Math.max(0, newFirst + height - scrolloff - 1), doc.lines - 1);
    head = doc.lineStart(line);
    if (head >= cursor) return;
  }
  const anchor = isSelect(cx) ? range.anchor : head;
  editor.setSelection(
    editor.selection.replace(editor.selection.primaryIndex, new Range(anchor, head)),
  );
}

function pageHeight(cx: Context): number {
  return cx.editor.host.viewport().height;
}

// ---- Finding characters ----

function findCharLineEndingMotion(
  editor: HelixEditor,
  n: number,
  direction: Direction,
  inclusive: boolean,
  extend: boolean,
): void {
  const doc = editor.doc;
  const selection = editor.selection.transform((range) => {
    const cursorAnchor = range.cursor(doc);
    const cursorHead = nextGraphemeBoundary(doc, cursorAnchor);
    const cursorLine = range.cursorLine(doc);
    let pos: number;
    if (direction === Direction.Forward) {
      const lineEnd = doc.lineEnd(cursorLine);
      const onEdge = inclusive
        ? lineEnd === cursorAnchor
        : lineEnd === cursorHead || lineEnd === cursorAnchor;
      const line = cursorLine + n - 1 + (onEdge ? 1 : 0);
      if (line >= doc.lines - 1) return range;
      pos = doc.lineEnd(line) - (inclusive ? 0 : 1);
    } else if (inclusive) {
      const line = cursorLine - n;
      if (line < 0) return range;
      pos = doc.lineEnd(line);
    } else {
      const onEdge = doc.lineStart(cursorLine) === cursorAnchor;
      const line = cursorLine - n + 1 - (onEdge ? 1 : 0);
      if (line <= 0) return range;
      pos = doc.lineStart(line);
    }
    return extend
      ? range.putCursor(doc, pos, true)
      : Range.point(range.cursor(doc)).putCursor(doc, pos, true);
  });
  editor.pushJump();
  editor.setSelection(selection);
}

function findChar(cx: Context, direction: Direction, inclusive: boolean, extend: boolean): void {
  const n = count(cx);
  cx.onNextKey((cx2, key) => {
    let motion: (editor: HelixEditor) => void;
    if (key === KEY.ret) {
      motion = (editor) => findCharLineEndingMotion(editor, n, direction, inclusive, extend);
    } else {
      const ch = key === KEY.tab ? "\t" : keyCharWithModifiers(key);
      if (ch === null) return;
      motion = (editor) => {
        const doc = editor.doc;
        const selection = editor.selection.transform((range) => {
          const cursorAnchor = range.cursor(doc);
          const cursorHead = nextGraphemeBoundary(doc, cursorAnchor);
          // An exclusive search skips the character after the cursor, so it can be repeated.
          let start: number;
          if (inclusive) start = direction === Direction.Forward ? cursorHead : cursorAnchor;
          else
            start =
              direction === Direction.Forward ? cursorHead + 1 : Math.max(0, cursorAnchor - 1);
          const found = findNthChar(n, doc, ch, start, direction);
          if (found === null) return range;
          const pos = inclusive ? found : direction === Direction.Forward ? found - 1 : found + 1;
          return extend
            ? range.putCursor(doc, pos, true)
            : Range.point(range.cursor(doc)).putCursor(doc, pos, true);
        });
        editor.pushJump();
        editor.setSelection(selection);
      };
    }
    applyMotion(cx2, motion);
  });
}

function repeatLastMotion(cx: Context): void {
  const motion = cx.editor.lastMotion;
  if (motion === null) return;
  for (let i = 0; i < count(cx); i++) motion(cx.editor);
}

// ---- Replacing and case ----

function replace(cx: Context): void {
  cx.onNextKey((cx2, key) => {
    const editor = cx2.editor;
    let ch: string | null;
    if (key === KEY.ret) ch = "\n";
    else if (key === KEY.tab) ch = "\t";
    else ch = keyCharWithModifiers(key);
    if (ch === null) return;
    const doc = editor.doc;
    const changes: Change[] = editor.selection.ranges
      .filter((r) => !r.empty)
      .map((r) => ({
        from: r.from,
        to: r.to,
        insert: graphemes(r.fragment(doc))
          .map(() => ch)
          .join(""),
      }));
    editor.apply(changes);
    editor.exitSelectMode();
  });
}

function switchCaseImpl(cx: Context, f: (s: string) => string): void {
  const editor = cx.editor;
  const doc = editor.doc;
  editor.apply(
    editor.selection.ranges.map((r) => ({ from: r.from, to: r.to, insert: f(r.fragment(doc)) })),
  );
  editor.exitSelectMode();
}

function switchCase(s: string): string {
  let out = "";
  for (const ch of s) {
    if (charIsLowercase(ch)) out += ch.toUpperCase();
    else if (charIsUppercase(ch)) out += ch.toLowerCase();
    else out += ch;
  }
  return out;
}

// ---- Selections ----

function copySelectionOnLine(cx: Context, direction: Direction): void {
  const n = count(cx);
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection;
  const tabWidth = editor.tabWidth;
  const ranges: Range[] = [...selection.ranges];
  let primaryIndex = 0;
  const coords = (pos: number) => ({ row: doc.lineOf(pos), col: visualColumn(doc, pos, tabWidth) });
  for (const range of selection.ranges) {
    const isPrimary = range.equals(selection.primary);
    const [head, anchor] =
      range.anchor < range.head
        ? [range.head - 1, range.anchor]
        : [range.head, Math.max(0, range.anchor - 1)];
    const headPos = coords(head);
    const anchorPos = coords(anchor);
    const height = Math.abs(headPos.row - anchorPos.row) + 1;
    if (isPrimary) primaryIndex = ranges.length;
    ranges.push(range);
    let sels = 0;
    let i = 0;
    while (sels < n) {
      const offset = (i + 1) * height;
      const anchorRow =
        direction === Direction.Forward ? anchorPos.row + offset : anchorPos.row - offset;
      const headRow = direction === Direction.Forward ? headPos.row + offset : headPos.row - offset;
      if (anchorRow < 0 || headRow < 0 || anchorRow >= doc.lines || headRow >= doc.lines) break;
      const newAnchor = posAtVisualColumn(doc, anchorRow, anchorPos.col, tabWidth);
      const newHead = posAtVisualColumn(doc, headRow, headPos.col, tabWidth);
      // Skip lines that are too short.
      if (
        visualColumn(doc, newAnchor, tabWidth) === anchorPos.col &&
        visualColumn(doc, newHead, tabWidth) === headPos.col
      ) {
        if (isPrimary) primaryIndex = ranges.length;
        ranges.push(Range.point(newAnchor).putCursor(doc, newHead, true));
        sels++;
      }
      if (anchorRow === 0 && headRow === 0) break;
      i++;
    }
  }
  editor.setSelection(new Selection(ranges, primaryIndex));
}

function selectAll(cx: Context): void {
  cx.editor.pushJump();
  cx.editor.setSelection(Selection.single(0, cx.editor.doc.length));
}

/**
 * Asks for a regex, applying it to the selection as it's typed, and putting the selection back
 * if the prompt is closed.
 */
function regexPrompt(
  cx: Context,
  label: string,
  historyRegister: string | null,
  f: (editor: HelixEditor, regex: RegExp, event: "update" | "validate") => void,
): void {
  const editor = cx.editor;
  const snapshot = editor.selection;
  editor.prompt = {
    label,
    historyRegister,
    input: "",
    onEvent: (ed, input, event) => {
      if (event === "abort") {
        ed.setSelection(snapshot);
        return;
      }
      if (input === "") return;
      const regex = buildRegex(input, ed.options.smartCase);
      ed.setSelection(snapshot);
      if (regex instanceof Error) {
        if (event === "validate") ed.setError(regex.message);
        return;
      }
      if (event === "validate") ed.jumps.push(snapshot);
      f(ed, regex, event);
    },
  };
  editor.onChange();
}

function selectRegex(cx: Context): void {
  const reg = cx.register ?? "/";
  regexPrompt(cx, "select:", reg, (editor, regex, event) => {
    const selection = selectOnMatches(editor.doc, editor.selection, regex);
    if (selection) editor.setSelection(selection);
    else if (event === "validate") editor.setError("nothing selected");
  });
}

function splitSelection(cx: Context): void {
  const reg = cx.register ?? "/";
  regexPrompt(cx, "split:", reg, (editor, regex) => {
    editor.setSelection(splitOnMatches(editor.doc, editor.selection, regex));
  });
}

function keepOrRemoveSelections(cx: Context, remove: boolean): void {
  const reg = cx.register ?? "/";
  regexPrompt(cx, remove ? "remove:" : "keep:", reg, (editor, regex, event) => {
    const selection = keepOrRemoveMatches(editor.doc, editor.selection, regex, remove);
    if (selection) editor.setSelection(selection);
    else if (event === "validate") editor.setError("no selections remaining");
  });
}

// ---- Searching ----

export function searchImpl(
  editor: HelixEditor,
  regex: RegExp,
  movement: Movement,
  direction: Direction,
  showWarnings: boolean,
): void {
  const doc = editor.doc;
  const selection = editor.selection;
  // After the primary block cursor going forwards, or before the start of the selection going
  // backwards.
  const start =
    direction === Direction.Forward
      ? ensureGraphemeBoundaryNext(doc, selection.primary.to)
      : ensureGraphemeBoundaryPrev(doc, selection.primary.from);
  let match: [number, number] | null =
    direction === Direction.Forward
      ? (findAll(doc, regex, start, doc.length)[0] ?? null)
      : (findAll(doc, regex, 0, start).at(-1) ?? null);
  if (match === null) {
    if (editor.options.wrapAround) {
      match =
        direction === Direction.Forward
          ? (findAll(doc, regex, 0, doc.length)[0] ?? null)
          : (findAll(doc, regex, start, doc.length).at(-1) ?? null);
    }
    if (showWarnings) {
      if (editor.options.wrapAround && match !== null) editor.setStatus("Wrapped around document");
      else editor.setError("No more matches");
    }
  }
  if (match === null) return;
  const [from, to] = match;
  // Skip empty matches that don't make sense.
  if (to === 0) return;
  const range = new Range(from, to).withDirection(selection.primary.direction);
  editor.setSelection(
    movement === Movement.Extend
      ? selection.push(range)
      : selection.replace(selection.primaryIndex, range),
  );
  editor.host.scroll({ kind: "align", pos: range.cursor(editor.doc), align: "center" });
}

function searcher(cx: Context, direction: Direction): void {
  const reg = cx.register ?? "/";
  const movement = behaviour(cx);
  regexPrompt(cx, "search:", reg, (editor, regex, event) => {
    if (event === "validate") editor.registers.lastSearchRegister = reg;
    searchImpl(editor, regex, movement, direction, false);
  });
}

function searchNextOrPrev(cx: Context, movement: Movement, direction: Direction): void {
  const n = count(cx);
  const editor = cx.editor;
  const register = cx.register ?? editor.registers.lastSearchRegister;
  const query = editor.registers.first(register);
  if (query === null) return;
  const regex = buildRegex(query, editor.options.smartCase);
  if (regex instanceof Error) {
    editor.setError(`Invalid regex: ${query}`);
    return;
  }
  for (let i = 0; i < n; i++) searchImpl(editor, regex, movement, direction, true);
  editor.pushJump();
}

function searchSelectionImpl(cx: Context, detectWordBoundaries: boolean): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const isAtWordStart = (index: number) => {
    if (index === doc.length) return false;
    const ch = doc.str.charAt(index);
    if (index === 0) return charIsWord(ch);
    return !charIsWord(doc.str.charAt(index - 1)) && charIsWord(ch);
  };
  const isAtWordEnd = (index: number) => {
    if (index === 0 || index === doc.length) return false;
    return charIsWord(doc.str.charAt(index - 1)) && !charIsWord(doc.str.charAt(index));
  };
  const register = cx.register ?? "/";
  const parts = new Set(
    editor.selection.ranges.map((r) => {
      const prefix = detectWordBoundaries && isAtWordStart(r.from) ? "\\b" : "";
      const suffix = detectWordBoundaries && isAtWordEnd(r.to) ? "\\b" : "";
      return `${prefix}${escapeRegex(r.fragment(doc))}${suffix}`;
    }),
  );
  const regex = [...parts].join("|");
  try {
    editor.registers.push(register, regex);
    editor.registers.lastSearchRegister = register;
    editor.setStatus(`register '${register}' set to '${regex}'`);
  } catch (e) {
    editor.setError((e as Error).message);
  }
}

function makeSearchWordBounded(cx: Context): void {
  const editor = cx.editor;
  const register = cx.register ?? editor.registers.lastSearchRegister;
  const regex = editor.registers.first(register);
  if (regex === null) return;
  const startAnchored = regex.startsWith("\\b");
  const endAnchored = regex.endsWith("\\b");
  if (startAnchored && endAnchored) return;
  const bounded = `${startAnchored ? "" : "\\b"}${regex}${endAnchored ? "" : "\\b"}`;
  try {
    editor.registers.push(register, bounded);
    editor.registers.lastSearchRegister = register;
    editor.setStatus(`register '${register}' set to '${bounded}'`);
  } catch (e) {
    editor.setError((e as Error).message);
  }
}

// ---- Lines ----

function extendLineImpl(cx: Context, extend: "above" | "below"): void {
  const n = count(cx);
  transform(cx, (range, doc) => {
    const [startLine, endLine] = range.lineRange(doc);
    const start = doc.lineStart(startLine);
    const end = doc.lineStart(Math.min(endLine + 1, doc.lines));
    let anchor: number;
    let head: number;
    // Extend to the previous or next line if the current line is selected.
    if (range.from === start && range.to === end) {
      if (extend === "above") [anchor, head] = [end, doc.lineStart(Math.max(0, startLine - n))];
      else [anchor, head] = [start, doc.lineStart(Math.min(endLine + n + 1, doc.lines))];
    } else if (extend === "above") {
      [anchor, head] = [end, doc.lineStart(Math.max(0, startLine - (n - 1)))];
    } else {
      [anchor, head] = [start, doc.lineStart(Math.min(endLine + n, doc.lines))];
    }
    return new Range(anchor, head);
  });
}

function selectLineImpl(cx: Context, extend: "above" | "below"): void {
  let n = count(cx);
  transform(cx, (range, doc) => {
    const add = (a: number, b: number) => Math.min(a + b, doc.lines);
    const [startLine, endLine] = range.lineRange(doc);
    const start = doc.lineStart(startLine);
    const end = doc.lineStart(add(endLine, 1));
    // Extending to the line bounds counts as one step.
    if (range.from !== start || range.to !== end) n = Math.max(0, n - 1);
    const forward = range.direction === Direction.Forward;
    let anchorLine: number;
    let headLine: number;
    if (extend === "above") {
      [anchorLine, headLine] = forward
        ? [startLine, Math.max(0, endLine - n)]
        : [endLine, Math.max(0, startLine - n)];
    } else {
      [anchorLine, headLine] = forward
        ? [startLine, add(endLine, n)]
        : [endLine, add(startLine, n)];
    }
    let anchor: number;
    let head: number;
    if (anchorLine < headLine) {
      [anchor, head] = [doc.lineStart(anchorLine), doc.lineStart(add(headLine, 1))];
    } else if (anchorLine === headLine) {
      [anchor, head] =
        extend === "above"
          ? [doc.lineStart(add(anchorLine, 1)), doc.lineStart(headLine)]
          : [doc.lineStart(headLine), doc.lineStart(add(anchorLine, 1))];
    } else {
      [anchor, head] = [doc.lineStart(add(anchorLine, 1)), doc.lineStart(headLine)];
    }
    return new Range(anchor, head);
  });
}

function extendToLineBounds(cx: Context): void {
  transform(cx, (range, doc) => {
    const [startLine, endLine] = range.lineRange(doc);
    return new Range(
      doc.lineStart(startLine),
      doc.lineStart(Math.min(endLine + 1, doc.lines)),
    ).withDirection(range.direction);
  });
}

function shrinkToLineBounds(cx: Context): void {
  transform(cx, (range, doc) => {
    const [startLine, endLine] = range.lineRange(doc);
    // Do nothing within one line.
    if (startLine === endLine) return range;
    let start = doc.lineStart(startLine);
    let end = doc.lineStart(Math.min(endLine + 1, doc.lines));
    if (start !== range.from) start = doc.lineStart(Math.min(startLine + 1, doc.lines));
    if (end !== range.to) end = doc.lineStart(endLine);
    return new Range(start, end).withDirection(range.direction);
  });
}

// ---- Deleting and changing ----

function selectionIsLinewise(selection: Selection, doc: Doc): boolean {
  return selection.ranges.every((range) => {
    if (!range.fragment(doc).includes("\n")) return false;
    const [startLine, endLine] = range.lineRange(doc);
    const start = doc.lineStart(startLine);
    const end = doc.lineStart(Math.min(endLine + 1, doc.lines));
    return start === range.from && end === range.to;
  });
}

function deleteSelectionImpl(cx: Context, op: "delete" | "change", yank: boolean): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection;
  const onlyWholeLines = selectionIsLinewise(selection, doc);
  if (cx.register !== "_" && yank) {
    try {
      editor.registers.write(defaultYankRegister(cx), selection.fragments(doc));
    } catch (e) {
      editor.setError((e as Error).message);
      return;
    }
  }
  editor.apply(deletions(selection.ranges.map((r) => [r.from, r.to] as const)));
  if (op === "delete") {
    editor.exitSelectMode();
  } else if (onlyWholeLines) {
    open(cx, "above", false);
  } else {
    editor.enterInsertMode();
  }
}

/** Deletes around each cursor in insert mode, as Helix's `delete_by_selection_insert_mode`. */
function deleteBySelectionInsertMode(
  cx: Context,
  f: (doc: Doc, range: Range) => [number, number],
  direction: Direction,
): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection;
  let insertNewline = false;
  const ranges: Range[] = [];
  const dels: [number, number][] = [];
  for (const range of selection.ranges) {
    const [start, end] = f(doc, range);
    if (direction === Direction.Forward) {
      let r = range;
      if (range.head > range.anchor) {
        if (end === doc.length) insertNewline = true;
        // Move the cursor right so the selection doesn't shrink as text after it is deleted.
        r = new Range(range.anchor, range.head + 1);
      }
      ranges.push(r);
    }
    dels.push([Math.min(start, end), Math.max(start, end)]);
  }
  const changes: Change[] = deletions(dels);
  // Deleting the last character would leave the cursor past the end, so add a line ending, as
  // appending does.
  if (insertNewline) changes.push({ from: doc.length, to: doc.length, insert: "\n" });
  if (direction === Direction.Backward) {
    editor.apply(changes);
    return;
  }
  // Moving the head right can take it a character past the end of the text, until the line
  // ending added above is there, as Helix's lenient positions allow.
  const newLength = changes.reduce((len, c) => len + c.insert.length - (c.to - c.from), doc.length);
  const clamp = (pos: number) => Math.min(pos, newLength);
  const mapped = ranges.map((r) => {
    const m = mapRange(changes, r);
    return new Range(clamp(m.anchor), clamp(m.head));
  });
  editor.apply(changes, new Selection(mapped, selection.primaryIndex));
}

// ---- Insert mode ----

function insertMode(cx: Context): void {
  cx.editor.enterInsertMode();
  cx.editor.setSelection(cx.editor.selection.transform((r) => new Range(r.to, r.from)));
}

function appendMode(cx: Context): void {
  const editor = cx.editor;
  editor.enterInsertMode();
  editor.restoreCursor = true;
  const doc = editor.doc;
  // Make room at the end of the document if the last range touches it.
  const last = at(editor.selection.ranges, editor.selection.ranges.length - 1);
  if (!last.empty && last.to === doc.length) {
    editor.apply([{ from: doc.length, to: doc.length, insert: "\n" }]);
  }
  const newDoc = editor.doc;
  editor.setSelection(
    editor.selection.transform((r) => new Range(r.from, nextGraphemeBoundary(newDoc, r.to))),
  );
}

function insertWithIndent(cx: Context, fallback: "start" | "end"): void {
  const wasSelect = isSelect(cx);
  const editor = cx.editor;
  editor.enterInsertMode();
  const doc = editor.doc;
  const selection = editor.selection;
  const ranges: Range[] = [];
  const changes: Change[] = [];
  let offs = 0;
  for (const range of selection.ranges) {
    const line = range.cursorLine(doc);
    const lineStart = doc.lineStart(line);
    if (doc.lineEnd(line) === lineStart) {
      // The line is empty, so indent it.
      const indent = editor.indentForNewline(line, lineStart);
      ranges.push(Range.point(offs + lineStart + indent.length));
      offs += indent.length;
      changes.push({ from: lineStart, to: lineStart, insert: indent });
    } else {
      const firstNonWs = firstNonWhitespace(doc, line);
      const pos = fallback === "start" ? lineStart + (firstNonWs ?? 0) : doc.lineEnd(line);
      ranges.push(range.putCursor(doc, pos + offs, wasSelect));
    }
  }
  editor.apply(changes, new Selection(ranges, selection.primaryIndex));
}

export function open(cx: Context, where: "below" | "above", commentContinuation: boolean): void {
  const n = count(cx);
  const editor = cx.editor;
  editor.enterInsertMode();
  const doc = editor.doc;
  const selection = editor.selection;
  const ranges: Range[] = [];
  const changes: Change[] = [];
  let offs = 0;
  for (const range of selection.ranges) {
    const currLine = doc.lineOf(
      where === "below" ? prevGraphemeBoundary(doc, range.to) : range.from,
    );
    const nextNewLine = where === "below" ? currLine + 1 : currLine;
    const aboveNextNewLine = Math.max(0, nextNewLine - 1);
    const token = commentContinuation
      ? getCommentToken(doc, editor.host.commentTokens(doc.lineStart(currLine)).line, currLine)
      : null;
    const [aboveEnd, aboveEndWidth] =
      nextNewLine === 0 ? [0, 0] : [doc.lineEnd(aboveNextNewLine), 1];
    const firstNonWs = firstNonWhitespace(doc, currLine);
    const indent =
      token !== null && firstNonWs !== null
        ? doc.line(currLine).slice(0, firstNonWs)
        : editor.indentForNewline(currLine, aboveEnd);
    let text: string;
    if (where === "above" && nextNewLine === 0) {
      text = `${indent}${token !== null ? `${token} ` : ""}\n`;
    } else {
      text = `\n${indent}${token !== null ? `${token} ` : ""}`;
    }
    text = text.repeat(n);
    const pos = offs + aboveEnd + aboveEndWidth;
    const commentLen = token !== null ? token.length + 1 : 0;
    for (let i = 0; i < n; i++) {
      ranges.push(
        Range.point(pos + i * (1 + indent.length + commentLen) + indent.length + commentLen),
      );
    }
    offs += text.length;
    changes.push({ from: aboveEnd, to: aboveEnd, insert: text });
  }
  editor.apply(changes, new Selection(ranges, selection.primaryIndex));
}

function addNewlineImpl(cx: Context, where: "above" | "below"): void {
  const n = count(cx);
  const editor = cx.editor;
  const doc = editor.doc;
  const changes = editor.selection.ranges.map((range) => {
    const [start, end] = range.lineRange(doc);
    const line = where === "above" ? start : end + 1;
    const pos = doc.lineStart(Math.min(line, doc.lines));
    return { from: pos, to: pos, insert: "\n".repeat(n) };
  });
  editor.apply(sortChanges(changes));
}

/** Sorts changes that start in the same place by the order they were made, and merges equal ones. */
function sortChanges(changes: Change[]): Change[] {
  const sorted = [...changes].sort((a, b) => a.from - b.from);
  const out: Change[] = [];
  for (const c of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.from === c.from && prev.to === c.to && prev.insert === c.insert) continue;
    if (prev && prev.from === c.from && prev.to === prev.from && c.to === c.from) {
      out[out.length - 1] = { from: c.from, to: c.to, insert: prev.insert + c.insert };
      continue;
    }
    out.push(c);
  }
  return out;
}

// ---- Typing in insert mode ----

const AUTO_PAIRS: readonly (readonly [string, string])[] = [
  ["(", ")"],
  ["{", "}"],
  ["[", "]"],
  ["'", "'"],
  ['"', '"'],
  ["`", "`"],
];

function autoPair(ch: string): { open: string; close: string } | null {
  for (const [open, close] of AUTO_PAIRS) if (open === ch || close === ch) return { open, close };
  return null;
}

/** Types `text` at every cursor, with auto pairs for a single character. */
export function insertChar(cx: Context, ch: string): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection;
  const pairs = editor.options.autoPairs;
  const result = changeByAndWithSelection(selection, (range) => {
    if (pairs && [...ch].length === 1) {
      const hooked = hookInsert(doc, range, ch);
      if (hooked) return hooked;
    }
    const cursor = range.cursor(doc);
    return [{ from: cursor, to: cursor, insert: ch }, null];
  });
  editor.apply(result.changes, result.selection);
}

function prevChar(doc: Doc, pos: number): string | undefined {
  return pos === 0 ? undefined : doc.str.charAt(pos - 1);
}

function shouldClose(doc: Doc, range: Range, same: boolean): boolean {
  const cursor = range.cursor(doc);
  const next = doc.char(cursor);
  let close = next === undefined || !charIsAlphanumeric(next);
  if (same) {
    const prev = prevChar(doc, cursor);
    close = close && (prev === undefined || !charIsAlphanumeric(prev));
  }
  return close;
}

function hookInsert(doc: Doc, range: Range, ch: string): [Change, Range] | null {
  const pair = autoPair(ch);
  if (pair) {
    if (pair.open === pair.close) return handleInsertSame(doc, range, pair.open);
    if (pair.open === ch) return handleInsertOpen(doc, range, pair);
    return handleInsertClose(doc, range, pair.close);
  }
  if (charIsWhitespace(ch)) return handleInsertWhitespace(doc, range, ch);
  return null;
}

function handleInsertOpen(
  doc: Doc,
  range: Range,
  pair: { open: string; close: string },
): [Change, Range] | null {
  const cursor = range.cursor(doc);
  if (doc.char(cursor) !== undefined && !shouldClose(doc, range, false)) return null;
  return [
    { from: cursor, to: cursor, insert: pair.open + pair.close },
    getNextRange(doc, range, 2),
  ];
}

function handleInsertClose(doc: Doc, range: Range, close: string): [Change, Range] | null {
  const cursor = range.cursor(doc);
  if (doc.char(cursor) !== close) return null;
  return [{ from: cursor, to: cursor, insert: "" }, getNextRange(doc, range, 0)];
}

function handleInsertSame(doc: Doc, range: Range, ch: string): [Change, Range] | null {
  const cursor = range.cursor(doc);
  if (doc.char(cursor) === ch)
    return [{ from: cursor, to: cursor, insert: "" }, getNextRange(doc, range, 0)];
  if (!shouldClose(doc, range, true)) return null;
  return [{ from: cursor, to: cursor, insert: ch + ch }, getNextRange(doc, range, 2)];
}

function handleInsertWhitespace(doc: Doc, range: Range, ch: string): [Change, Range] | null {
  const cursor = range.cursor(doc);
  const cur = doc.char(cursor);
  const prev = prevChar(doc, cursor);
  if (cur === undefined || prev === undefined) return null;
  const pair = autoPair(cur);
  if (pair === null || pair.open !== prev || pair.close !== cur) return null;
  return handleInsertSame(doc, range, ch);
}

/** Where the range goes after an auto pair inserts `inserted` characters at its cursor. */
function getNextRange(doc: Doc, start: Range, inserted: number): Range {
  // Inserting at the very end of the document, after the last line ending.
  if (start.head === doc.length && start.anchor === doc.length) {
    return new Range(start.anchor + 1, start.head + 1);
  }
  const single = start.isSingleGrapheme(doc);
  // Just skip over graphemes.
  if (inserted === 0) {
    const endAnchor = single ? nextGraphemeBoundary(doc, start.anchor) : start.anchor;
    return new Range(endAnchor, nextGraphemeBoundary(doc, start.head));
  }
  // Only a single-character opener was inserted, so just move the selection.
  if (inserted === 1) {
    const endAnchor =
      single || start.direction === Direction.Backward ? start.anchor + 1 : start.anchor;
    return new Range(endAnchor, start.head + 1);
  }
  const endHead =
    start.head === 0 || start.direction === Direction.Backward
      ? start.head + 1
      : prevGraphemeBoundary(doc, start.head) + inserted;
  let endAnchor: number;
  if (start.length === 0) {
    endAnchor = endHead;
  } else if (start.length === 1) {
    endAnchor = start.direction === Direction.Forward ? endHead - 1 : endHead + 1;
  } else if (start.direction === Direction.Forward) {
    endAnchor = single ? prevGraphemeBoundary(doc, start.head) + 1 : start.anchor;
  } else {
    endAnchor = single
      ? prevGraphemeBoundary(doc, start.anchor) + inserted
      : start.anchor + inserted;
  }
  return new Range(endAnchor, endHead);
}

function hookDelete(doc: Doc, range: Range): [[number, number], Range] | null {
  const cursor = range.cursor(doc);
  const cur = doc.char(cursor);
  const prev = prevChar(doc, cursor);
  if (cur === undefined || prev === undefined) return null;
  // Whitespace surrounding a pair.
  if (doc.length >= 4 && charIsWhitespace(prev) && charIsWhitespace(cur)) {
    const secondPrev = doc.char(nthPrevGraphemeBoundary(doc, cursor, 2));
    const secondNext = doc.char(nextGraphemeBoundary(doc, cursor));
    if (secondPrev !== undefined && secondNext !== undefined) {
      const pair = autoPair(secondPrev);
      if (pair && pair.open === secondPrev && pair.close === secondNext)
        return handleDelete(doc, range);
    }
  }
  const pair = autoPair(cur);
  if (pair === null || pair.open !== prev || pair.close !== cur) return null;
  return handleDelete(doc, range);
}

function handleDelete(doc: Doc, range: Range): [[number, number], Range] {
  const cursor = range.cursor(doc);
  const endNext = nextGraphemeBoundary(doc, cursor);
  const endPrev = prevGraphemeBoundary(doc, cursor);
  const sizeDelete = endNext - endPrev;
  const nextHead = nextGraphemeBoundary(doc, range.head) - sizeDelete;
  const single = range.isSingleGrapheme(doc);
  let nextAnchor: number;
  if (range.direction === Direction.Forward)
    nextAnchor = single ? range.anchor - (endNext - cursor) : range.anchor;
  else nextAnchor = single ? range.anchor - (cursor - endPrev) : range.anchor - sizeDelete;
  return [[endPrev, endNext], new Range(nextAnchor, nextHead)];
}

function insertNewline(cx: Context): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection;
  const ranges: Range[] = [];
  const changes: Change[] = [];
  let globalOffs = 0;
  let lastPos = 0;
  for (const range of selection.ranges) {
    let charsDeleted = 0;
    const pos = range.cursor(doc);
    const prev = pos === 0 ? " " : doc.str.charAt(pos - 1);
    const curr = doc.char(pos) ?? " ";
    const currentLine = doc.lineOf(pos);
    const lineStart = doc.lineStart(currentLine);
    const token = getCommentToken(doc, editor.host.commentTokens(lineStart).line, currentLine);
    let newText = "";
    let from: number;
    let to: number;
    let localOffs: number;
    const lastNonWs = backwardsSkipWhile(doc, pos, (c) => charIsWhitespace(c));
    if (lastNonWs !== null && lastNonWs > lineStart) {
      const firstTrailingWs = Math.min(Math.max(lastNonWs, lastPos), pos);
      lastPos = pos;
      const firstNonWs = firstNonWhitespace(doc, currentLine);
      const indent =
        token !== null && firstNonWs !== null
          ? doc.line(currentLine).slice(0, firstNonWs)
          : editor.indentForNewline(currentLine, pos);
      // Between a pair, such as brackets, add a line indented a level more, with the cursor on it.
      const pair = autoPair(prev);
      const onAutoPair =
        editor.options.autoPairs && pair !== null && pair.open === prev && pair.close === curr;
      if (token !== null) {
        newText = `\n${indent}${token} `;
        localOffs = newText.length;
      } else if (onAutoPair) {
        newText = `\n${indent}${editor.indentUnit}`;
        localOffs = newText.length;
        newText += `\n${indent}`;
      } else {
        newText = `\n${indent}`;
        localOffs = newText.length;
      }
      charsDeleted = pos - firstTrailingWs;
      from = firstTrailingWs;
      to = pos;
      localOffs -= charsDeleted;
    } else {
      // A line of only whitespace: break at its start, so it becomes empty and the new line has
      // its indentation.
      newText = "\n";
      from = lineStart;
      to = lineStart;
      localOffs = newText.length;
    }
    const newRange =
      range.cursor(doc) > range.anchor
        ? // Appending: extend the range.
          new Range(range.anchor + globalOffs, range.head + localOffs + globalOffs)
        : // Inserting: slide the range.
          new Range(range.anchor + localOffs + globalOffs, range.head + localOffs + globalOffs);
    ranges.push(newRange);
    globalOffs += newText.length - charsDeleted;
    changes.push({ from, to, insert: newText });
  }
  editor.apply(changes, new Selection(ranges, selection.primaryIndex));
}

function dedent(editor: HelixEditor, doc: Doc, range: Range): [number, number] | null {
  const pos = range.cursor(doc);
  const lineStart = doc.lineStart(range.cursorLine(doc));
  const fragment = doc.slice(lineStart, pos);
  if (fragment === "" || !/^[ \t]*$/.test(fragment)) return null;
  if (doc.char(pos - 1) === "\t") return [nthPrevGraphemeBoundary(doc, pos, 1), pos];
  const tabWidth = editor.tabWidth;
  const width = [...fragment].reduce((sum, ch) => sum + (ch === "\t" ? tabWidth : 1), 0);
  let drop = width % editor.indentWidth;
  if (drop === 0) drop = editor.indentWidth;
  let start = pos;
  for (let i = 0; i < drop; i++) {
    if (doc.char(start - 1) === " ") start--;
    else break;
  }
  return [start, pos];
}

function deleteCharBackward(cx: Context): void {
  const n = count(cx);
  const editor = cx.editor;
  const doc = editor.doc;
  const result = deleteByAndWithSelection(editor.selection, (range) => {
    const pos = range.cursor(doc);
    if (pos === 0) return [[pos, pos], null];
    const d = dedent(editor, doc, range);
    if (d) return [d, null];
    if (editor.options.autoPairs) {
      const hooked = hookDelete(doc, range);
      if (hooked) return hooked;
    }
    return [[nthPrevGraphemeBoundary(doc, pos, n), pos], null];
  });
  editor.apply(result.changes, result.selection);
}

function insertTabImpl(cx: Context, n: number): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const style = editor.indentStyle;
  editor.apply(
    editor.selection.ranges.map((range) => {
      const cursor = range.cursor(doc);
      let indent = editor.indentUnit.repeat(n);
      if (style.kind === IndentStyleKind.Spaces) {
        const lineStart = doc.lineStart(range.cursorLine(doc));
        indent = indent.slice((cursor - lineStart) % style.n);
      }
      return { from: cursor, to: cursor, insert: indent };
    }),
  );
}

function smartTab(cx: Context): void {
  const editor = cx.editor;
  if (editor.options.smartTab) {
    const doc = editor.doc;
    const afterWhitespace = editor.selection.ranges.every((range) => {
      const cursor = range.cursor(doc);
      const lineStart = doc.lineStart(doc.lineOf(cursor));
      return /^\s*$/.test(doc.slice(lineStart, cursor));
    });
    if (!afterWhitespace) {
      moveParentNodeEndPlain(cx);
      return;
    }
  }
  insertTabImpl(cx, 1);
}

/**
 * Moves each cursor past the bracket closing the innermost pair around it. Helix moves to the end
 * of the syntax node around the cursor; brackets stand in for nodes here.
 */
function moveParentNodeEndPlain(cx: Context): void {
  transform(cx, (range, doc) => {
    const pair = findMatchingBracketFuzzy(doc, range.cursor(doc));
    if (pair === null || pair < range.cursor(doc)) return range;
    const end = nextGraphemeBoundary(doc, pair);
    return range.direction === Direction.Forward
      ? new Range(end, nextGraphemeBoundary(doc, end))
      : new Range(nextGraphemeBoundary(doc, end), end);
  });
}

function insertSelectionInteractive(cx: Context, oldMode: Mode): void {
  const n = count(cx);
  cx.onNextKey((cx2, key) => {
    const ch = keyCharWithModifiers(key);
    if (key === KEY.ret) {
      if (n !== 1) {
        cx2.editor.setError("inserting multiple newlines not yet supported");
        return;
      }
      insertNewline(cx2);
    } else if (key === KEY.tab) {
      insertTabImpl(cx2, n);
    } else if (ch !== null) {
      for (let i = 0; i < n; i++) insertChar(cx2, ch);
    }
    cx2.editor.setMode(oldMode);
  });
}

// ---- Undo ----

function undoImpl(cx: Context, redo: boolean): void {
  const n = count(cx);
  for (let i = 0; i < n; i++) {
    if (!(redo ? cx.editor.host.redo() : cx.editor.host.undo())) {
      cx.editor.setStatus(redo ? "Already at newest change" : "Already at oldest change");
      break;
    }
  }
}

// ---- Yanking and pasting ----

function yankImpl(editor: HelixEditor, register: string): void {
  const values = editor.selection.fragments(editor.doc);
  try {
    editor.registers.write(register, values);
    editor.setStatus(
      `yanked ${values.length} selection${values.length === 1 ? "" : "s"} to register ${register}`,
    );
  } catch (e) {
    editor.setError((e as Error).message);
  }
}

function yankJoinedImpl(editor: HelixEditor, separator: string, register: string): void {
  const values = editor.selection.fragments(editor.doc);
  try {
    editor.registers.write(register, [values.join(separator)]);
    editor.setStatus(
      `joined and yanked ${values.length} selection${values.length === 1 ? "" : "s"} to register ${register}`,
    );
  } catch (e) {
    editor.setError((e as Error).message);
  }
}

function yankMainSelectionToRegister(editor: HelixEditor, register: string): void {
  try {
    editor.registers.write(register, [editor.selection.primary.fragment(editor.doc)]);
    editor.setStatus(`yanked primary selection to register ${register}`);
  } catch (e) {
    editor.setError((e as Error).message);
  }
}

export type PasteKind = "before" | "after" | "cursor";

export function pasteImpl(
  editor: HelixEditor,
  values: readonly string[],
  action: PasteKind,
  n: number,
): void {
  if (values.length === 0) return;
  // A paste is its own undo step, even in the middle of insert mode.
  if (editor.mode === "insert") editor.commitUndoCheckpoint();
  // If any value ends with a line ending, it's a linewise paste.
  const linewise = values.some((v) => v.endsWith("\n") || v.endsWith("\r"));
  const mapValue = (v: string) => v.replace(/\r\n|\r|\n/g, "\n").repeat(n);
  const doc = editor.doc;
  const selection = editor.selection;
  let offset = 0;
  const ranges: Range[] = [];
  const changes: Change[] = [];
  selection.ranges.forEach((range, i) => {
    let pos: number;
    if (action === "cursor") pos = range.cursor(doc);
    else if (linewise && action === "before") pos = doc.lineStart(doc.lineOf(range.from));
    else if (linewise) pos = doc.lineStart(Math.min(range.lineRange(doc)[1] + 1, doc.lines));
    else pos = action === "before" ? range.from : range.to;
    const value = mapValue(at(values, Math.min(i, values.length - 1)));
    const anchor = offset + pos;
    ranges.push(new Range(anchor, anchor + value.length).withDirection(range.direction));
    offset += value.length;
    changes.push({ from: pos, to: pos, insert: value });
  });
  editor.apply(
    sortChanges(changes),
    editor.mode === "normal" ? new Selection(ranges, selection.primaryIndex) : undefined,
  );
  editor.commitUndoCheckpoint();
}

async function paste(cx: Context, register: string, action: PasteKind): Promise<void> {
  const values = await cx.editor.registers.read(register);
  if (values === null) return;
  pasteImpl(cx.editor, values, action, count(cx));
}

export async function replaceSelectionsWithRegister(
  editor: HelixEditor,
  register: string,
  n: number,
): Promise<void> {
  const values = await editor.registers.read(register);
  if (values === null || values.length === 0) return;
  const mapValue = (v: string) => v.replace(/\r\n|\r|\n/g, "\n").repeat(n);
  const changes: Change[] = [];
  editor.selection.ranges.forEach((range, i) => {
    if (!range.empty) {
      changes.push({
        from: range.from,
        to: range.to,
        insert: mapValue(at(values, Math.min(i, values.length - 1))),
      });
    }
  });
  editor.apply(changes);
}

// ---- Indenting ----

function getLines(doc: Doc, selection: Selection): number[] {
  const lines = new Set<number>();
  for (const range of selection.ranges) {
    const [start, end] = range.lineRange(doc);
    for (let l = start; l <= end; l++) lines.add(l);
  }
  return [...lines].sort((a, b) => a - b);
}

function indent(cx: Context): void {
  const n = count(cx);
  const editor = cx.editor;
  const doc = editor.doc;
  const style = editor.indentStyle;
  const unit = editor.indentUnit.repeat(n);
  const changes: Change[] = [];
  for (const line of getLines(doc, editor.selection)) {
    if (doc.line(line).trim() === "") continue;
    const pos = doc.lineStart(line);
    let text = unit;
    if (style.kind === IndentStyleKind.Spaces)
      text = unit.slice((firstNonWhitespace(doc, line) ?? 0) % style.n);
    changes.push({ from: pos, to: pos, insert: text });
  }
  editor.apply(changes);
  editor.exitSelectMode();
}

function unindent(cx: Context): void {
  const n = count(cx);
  const editor = cx.editor;
  const doc = editor.doc;
  const tabWidth = editor.tabWidth;
  const width = n * editor.indentWidth;
  const changes: Change[] = [];
  for (const line of getLines(doc, editor.selection)) {
    const text = doc.line(line);
    let w = 0;
    let pos = 0;
    for (const ch of text) {
      if (ch === " ") w++;
      else if (ch === "\t") w = (Math.floor(w / tabWidth) + 1) * tabWidth;
      else break;
      pos++;
      if (w >= width) break;
    }
    if (pos > 0) {
      const start = doc.lineStart(line);
      changes.push({ from: start, to: start + pos, insert: "" });
    }
  }
  editor.apply(changes);
  editor.exitSelectMode();
}

function joinSelectionsImpl(cx: Context, selectSpace: boolean): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const changes: Change[] = [];
  for (const range of editor.selection.ranges) {
    const [start, rawEnd] = range.lineRange(doc);
    const end = start === rawEnd ? Math.min(rawEnd + 1, doc.lines - 1) : rawEnd;
    // Longest first, so `///` is found before `//`.
    const commentTokens = [...editor.host.commentTokens(doc.lineStart(start)).line].sort(
      (a, b) => b.length - a.length,
    );
    const firstLineIdx =
      skipWhile(doc, doc.lineStart(start), (c) => c === " " || c === "\t") ?? doc.lineStart(start);
    let currentToken = commentTokens.find((t) => doc.str.startsWith(t, firstLineIdx)) ?? null;
    for (let line = start; line < end; line++) {
      const from = doc.lineEnd(line);
      let to = doc.lineStart(line + 1);
      to = skipWhile(doc, to, (c) => c === " " || c === "\t") ?? to;
      const token = commentTokens.find((t) => doc.str.startsWith(t, to));
      if (token !== undefined) {
        if (token === currentToken) {
          to += token.length;
          to = skipWhile(doc, to, (c) => c === " " || c === "\t") ?? to;
        } else {
          currentToken = token;
        }
      }
      // A joined line of only spaces adds no space.
      const separator = to === doc.lineEnd(line + 1) ? "" : " ";
      changes.push({ from, to, insert: separator });
    }
  }
  if (changes.length === 0) return;
  changes.sort((a, b) => a.from - b.from);
  const deduped = changes.filter((c, i) => {
    const prev = changes[i - 1];
    return (
      prev === undefined || !(c.from === prev.from && c.to === prev.to && c.insert === prev.insert)
    );
  });
  if (selectSpace) {
    let offset = 0;
    const ranges: Range[] = [];
    for (const change of deduped) {
      if (change.insert !== "") {
        ranges.push(Range.point(change.from - offset));
        offset += change.to - change.from - 1;
      } else {
        offset += change.to - change.from;
      }
    }
    editor.apply(deduped, ranges.length > 0 ? new Selection(ranges, 0) : undefined);
  } else {
    editor.apply(deduped);
  }
}

// ---- Primary selection and rotating ----

function rotateSelections(cx: Context, direction: Direction): void {
  const n = count(cx);
  const sel = cx.editor.selection;
  const len = sel.length;
  const index =
    direction === Direction.Forward
      ? (sel.primaryIndex + n) % len
      : (sel.primaryIndex + (Math.max(0, len - n) % len)) % len;
  cx.editor.setSelection(sel.withPrimaryIndex(index));
}

function reorderSelectionContents(cx: Context, strategy: "forward" | "backward" | "reverse"): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection;
  const fragments = selection.fragments(doc);
  const rotateBy = cx.count === null ? 1 : Math.min(cx.count, fragments.length);
  const len = fragments.length;
  let primaryIndex: number;
  let reordered: string[];
  if (strategy === "forward") {
    reordered = [
      ...fragments.slice(len - (rotateBy % len)),
      ...fragments.slice(0, len - (rotateBy % len)),
    ];
    primaryIndex = (selection.primaryIndex + len + rotateBy) % len;
  } else if (strategy === "backward") {
    reordered = [...fragments.slice(rotateBy % len), ...fragments.slice(0, rotateBy % len)];
    primaryIndex = (selection.primaryIndex + len - rotateBy) % len;
  } else {
    // Reversing an even number of times changes nothing.
    if (rotateBy % 2 === 0) return;
    reordered = [...fragments].reverse();
    primaryIndex = len - 1 - selection.primaryIndex;
  }
  editor.setSelection(new Selection(selection.ranges, primaryIndex));
  editor.apply(
    selection.ranges.map((r, i) => ({ from: r.from, to: r.to, insert: at(reordered, i) })),
  );
}

// ---- Textobjects ----

function textobjectMotion(cx: Context, f: (doc: Doc, range: Range) => Range): void {
  applyMotion(cx, (editor) => {
    const doc = editor.doc;
    editor.setSelection(editor.selection.transform((r) => f(doc, r)));
  });
}

function textobjectSurroundingPair(
  cx: Context,
  textobject: TextObject,
  ch: string,
  direction: Direction | null,
): void {
  if (/^[A-Za-z0-9]$/.test(ch)) return;
  const n = count(cx);
  const findType =
    direction === null
      ? FindType.Surround
      : direction === Direction.Forward
        ? FindType.Next
        : FindType.Prev;
  textobjectMotion(cx, (doc, range) => {
    const r = textobjectPairSurround(doc, range, textobject, ch, findType, n);
    return direction === null ? r : r.withDirection(direction);
  });
}

/** Fallback commands, which take the character pressed after their keys. */
export const FALLBACKS: Readonly<Record<string, (cx: Context, ch: string) => void>> = {
  select_textobject_inside_surrounding_pair: (cx, ch) =>
    textobjectSurroundingPair(cx, TextObject.Inside, ch, null),
  select_textobject_around_surrounding_pair: (cx, ch) =>
    textobjectSurroundingPair(cx, TextObject.Around, ch, null),
  select_textobject_inside_prev_pair: (cx, ch) =>
    textobjectSurroundingPair(cx, TextObject.Inside, ch, Direction.Backward),
  select_textobject_inside_next_pair: (cx, ch) =>
    textobjectSurroundingPair(cx, TextObject.Inside, ch, Direction.Forward),
};

// ---- Surround ----

function surroundAdd(cx: Context): void {
  cx.editor.autoinfo = {
    title: "Surround selections with",
    body: SURROUND_HELP.slice(1),
  };
  cx.onNextKey((cx2, key) => {
    const editor = cx2.editor;
    editor.autoinfo = null;
    let open: string;
    let close: string;
    const ch = keyCharWithModifiers(key);
    if (ch !== null) {
      [open, close] = getPair(ch);
    } else if (key === KEY.ret) {
      [open, close] = ["\n", "\n"];
    } else {
      return;
    }
    const surroundLen = open.length + close.length;
    const selection = editor.selection;
    const changes: Change[] = [];
    const ranges: Range[] = [];
    let offs = 0;
    for (const range of selection.ranges) {
      changes.push({ from: range.from, to: range.from, insert: open });
      changes.push({ from: range.to, to: range.to, insert: close });
      ranges.push(
        new Range(offs + range.from, offs + range.to + surroundLen).withDirection(range.direction),
      );
      offs += surroundLen;
    }
    editor.apply(sortChanges(changes), new Selection(ranges, selection.primaryIndex));
    editor.exitSelectMode();
  });
}

const SURROUND_HELP: [string, string][] = [
  ["m", "Nearest matching pair"],
  ["( or )", "Parentheses"],
  ["{ or }", "Curly braces"],
  ["< or >", "Angled brackets"],
  ["[ or ]", "Square brackets"],
  [" ", "... or any character"],
];

function surroundReplace(cx: Context): void {
  const n = count(cx);
  cx.editor.autoinfo = { title: "Replace surrounding pair of", body: SURROUND_HELP };
  cx.onNextKey((cx2, key) => {
    const editor = cx2.editor;
    editor.autoinfo = null;
    const raw = keyCharWithModifiers(key);
    if (raw === null) return;
    const surroundCh = raw === "m" ? null : raw;
    const doc = editor.doc;
    const selection = editor.selection;
    const changePos = getSurroundPos(doc, selection, surroundCh, n);
    if (changePos instanceof SurroundError) {
      editor.setError(changePos.message);
      return;
    }
    editor.setSelection(
      new Selection(
        changePos.map((p) => Range.point(p)),
        selection.primaryIndex * 2,
      ),
    );
    editor.autoinfo = { title: "Replace with a pair of", body: SURROUND_HELP.slice(1) };
    cx2.onNextKey((cx3, key2) => {
      const ed = cx3.editor;
      ed.autoinfo = null;
      const to = keyCharWithModifiers(key2);
      if (to === null) {
        ed.setSelection(selection);
        return;
      }
      const [open, close] = getPair(to);
      const sorted: [number, string][] = [];
      for (let i = 0; i < changePos.length; i += 2) {
        sorted.push([at(changePos, i), open], [at(changePos, i + 1), close]);
      }
      sorted.sort((a, b) => a[0] - b[0]);
      ed.setSelection(selection);
      ed.apply(sorted.map(([pos, ch]) => ({ from: pos, to: pos + 1, insert: ch })));
      ed.exitSelectMode();
    });
  });
}

function surroundDelete(cx: Context): void {
  const n = count(cx);
  cx.editor.autoinfo = { title: "Delete surrounding pair of", body: SURROUND_HELP };
  cx.onNextKey((cx2, key) => {
    const editor = cx2.editor;
    editor.autoinfo = null;
    const raw = keyCharWithModifiers(key);
    if (raw === null) return;
    const surroundCh = raw === "m" ? null : raw;
    const changePos = getSurroundPos(editor.doc, editor.selection, surroundCh, n);
    if (changePos instanceof SurroundError) {
      editor.setError(changePos.message);
      return;
    }
    const sorted = [...changePos].sort((a, b) => a - b);
    editor.apply(sorted.map((p) => ({ from: p, to: p + 1, insert: "" })));
    editor.exitSelectMode();
  });
}

// ---- Registers ----

function selectRegister(cx: Context): void {
  cx.editor.autoinfo = { title: "Select register", body: cx.editor.registers.preview() };
  cx.onNextKey((cx2, key) => {
    cx2.editor.autoinfo = null;
    const ch = keyCharWithModifiers(key);
    if (ch !== null) cx2.editor.selectedRegister = ch;
  });
}

function insertRegister(cx: Context): void {
  const n = count(cx);
  cx.editor.autoinfo = { title: "Insert register", body: cx.editor.registers.preview() };
  cx.onNextKey(async (cx2, key) => {
    cx2.editor.autoinfo = null;
    const ch = keyCharWithModifiers(key);
    if (ch === null) return;
    const values = await cx2.editor.registers.read(ch);
    if (values === null) return;
    pasteImpl(cx2.editor, values, "cursor", n);
  });
}

function copyBetweenRegisters(cx: Context): void {
  cx.editor.autoinfo = { title: "Copy from register", body: cx.editor.registers.preview() };
  cx.onNextKey(async (cx2, key) => {
    const editor = cx2.editor;
    editor.autoinfo = null;
    const source = keyCharWithModifiers(key);
    if (source === null) return;
    const values = await editor.registers.read(source);
    if (values === null) {
      editor.setError(`register ${source} is empty`);
      return;
    }
    editor.autoinfo = { title: "Copy into register", body: editor.registers.preview() };
    cx2.onNextKey((cx3, key2) => {
      cx3.editor.autoinfo = null;
      const dest = keyCharWithModifiers(key2);
      if (dest === null) return;
      try {
        cx3.editor.registers.write(dest, values);
        cx3.editor.setStatus(
          `yanked ${values.length} value${values.length === 1 ? "" : "s"} from register ${source} to ${dest}`,
        );
      } catch (e) {
        cx3.editor.setError((e as Error).message);
      }
    });
  });
}

// ---- Macros ----

function recordMacro(cx: Context): void {
  const editor = cx.editor;
  if (editor.macroRecording) {
    const { register, keys } = editor.macroRecording;
    editor.macroRecording = null;
    // Leave out the key that ended the recording.
    keys.pop();
    const s = keys.map((k) => ([...k].length === 1 ? k : `<${k}>`)).join("");
    try {
      editor.registers.write(register, [s]);
      editor.setStatus(`Recorded to register [${register}]`);
    } catch (e) {
      editor.setError((e as Error).message);
    }
  } else {
    const register = cx.register ?? "@";
    cx.register = null;
    editor.macroRecording = { register, keys: [] };
    editor.setStatus(`Recording to register [${register}]`);
  }
}

async function replayMacro(cx: Context): Promise<void> {
  const editor = cx.editor;
  const register = cx.register ?? "@";
  if (editor.macroReplaying.includes(register)) {
    editor.setError(
      `Cannot replay from register [${register}] because already replaying from same register`,
    );
    return;
  }
  const values = await editor.registers.read(register);
  if (values === null || values.length !== 1) {
    editor.setError(`Register [${register}] empty`);
    return;
  }
  let keys: Key[];
  try {
    keys = parseMacro(at(values, 0));
  } catch (e) {
    editor.setError(`Invalid macro: ${(e as Error).message}`);
    return;
  }
  editor.macroReplaying.push(register);
  const times = count(cx);
  // The keys run once this key is done, and the register counts as replaying until they have.
  cx.defer(async () => {
    try {
      for (let i = 0; i < times; i++) await cx.feedKeys(keys);
    } finally {
      editor.macroReplaying.pop();
    }
  });
}

// ---- Jump labels ----

function jumpToWord(cx: Context, movement: Movement): void {
  const editor = cx.editor;
  const alphabet = [...editor.options.jumpLabelAlphabet];
  if (alphabet.length === 0) return;
  const limit = alphabet.length * alphabet.length;
  const words: Range[] = [];
  const doc = editor.doc;
  const { firstLine, lastLine } = editor.host.viewport();
  const start = doc.lineStart(firstLine);
  const end = doc.lineStart(Math.min(lastLine + 1, doc.lines));
  const primary = editor.selection.primary;
  const cursor = primary.cursor(doc);
  let fwd = Range.point(cursor);
  let rev = Range.point(cursor);
  const atCursor = doc.char(cursor);
  if (atCursor !== undefined && !charIsWhitespace(atCursor)) {
    const wordEnd = wordMove(doc, fwd, 1, WordMotionTarget.NextWordEnd);
    // Single grapheme words need a special case.
    if (wordEnd.anchor === cursor) fwd = wordEnd;
    const wordStart = wordMove(doc, rev, 1, WordMotionTarget.PrevWordStart);
    if (wordStart.anchor === nextGraphemeBoundary(doc, cursor)) rev = wordStart;
  }
  const isWordGrapheme = (g: string) => [...g].every(charIsWord);
  outer: for (;;) {
    let changed = false;
    while (fwd.head < end) {
      fwd = wordMove(doc, fwd, 1, WordMotionTarget.NextWordEnd);
      const before = graphemes(doc.slice(Math.max(0, fwd.head - 8), fwd.head)).slice(-2);
      if (!(before.length === 2 && before.every(isWordGrapheme))) continue;
      changed = true;
      let anchor = fwd.anchor;
      while (anchor < doc.length && !charIsWord(doc.str.charAt(anchor))) anchor++;
      fwd = new Range(anchor, fwd.head);
      words.push(fwd);
      if (words.length === limit) break outer;
      break;
    }
    while (rev.head > start) {
      rev = wordMove(doc, rev, 1, WordMotionTarget.PrevWordStart);
      const after = graphemes(doc.slice(rev.head, rev.head + 8)).slice(0, 2);
      if (!(after.length === 2 && after.every(isWordGrapheme))) continue;
      changed = true;
      let anchor = rev.anchor;
      while (anchor > 0 && !charIsWord(doc.str.charAt(anchor - 1))) anchor--;
      rev = new Range(anchor, rev.head);
      words.push(rev);
      if (words.length === limit) break outer;
      break;
    }
    if (!changed) break;
  }
  jumpToLabel(cx, words, movement);
}

function jumpToLabel(cx: Context, labels: Range[], movement: Movement): void {
  const editor = cx.editor;
  const alphabet = [...editor.options.jumpLabelAlphabet];
  if (labels.length === 0) return;
  editor.jumpLabels = labels.map((range, i) => ({
    from: range.from,
    label: at(alphabet, Math.floor(i / alphabet.length)) + at(alphabet, i % alphabet.length),
  }));
  editor.onChange();
  const primary = editor.selection.primary;
  const clear = (ed: HelixEditor) => {
    ed.jumpLabels = [];
    ed.onChange();
  };
  const labelIndex = (key: Key) => {
    const parsed = unparseKey(key);
    if (parsed.alt || parsed.ctrl || parsed.meta) return -1;
    return alphabet.indexOf(parsed.code);
  };
  cx.onNextKey((cx2, key) => {
    const i = labelIndex(key);
    if (i === -1 || i * alphabet.length > labels.length) {
      clear(cx2.editor);
      return;
    }
    const outer = i * alphabet.length;
    cx2.onNextKey((cx3, key2) => {
      clear(cx3.editor);
      const inner = labelIndex(key2);
      if (inner === -1) return;
      let range = labels[outer + inner];
      if (range === undefined) return;
      if (movement === Movement.Extend) {
        let anchor: number;
        if (range.anchor < range.head)
          anchor = range.anchor < primary.from ? range.anchor : primary.from;
        else anchor = range.anchor > primary.to ? range.anchor : primary.to;
        range = new Range(anchor, range.head);
      } else {
        range = range.withDirection(Direction.Forward);
      }
      cx3.editor.pushJump();
      cx3.editor.setSelection(new Selection([range], 0));
    });
  });
}

// ---- Diagnostics ----

function gotoDiag(cx: Context, which: "first" | "last" | "next" | "prev"): void {
  const run = (editor: HelixEditor) => {
    const diagnostics = editor.host.diagnostics();
    const cursor = editor.selection.primary.cursor(editor.doc);
    let selection: Selection | null = null;
    const first = diagnostics[0];
    const last = diagnostics[diagnostics.length - 1];
    if (which === "first" && first) selection = Selection.single(first.from, first.to);
    if (which === "last" && last) selection = Selection.single(last.from, last.to);
    if (which === "next") {
      const d = diagnostics.find((diag) => diag.from > cursor);
      if (d) selection = Selection.single(d.from, d.to);
    }
    if (which === "prev") {
      const d = [...diagnostics].reverse().find((diag) => diag.from < cursor);
      // Backwards, as it's the previous one.
      if (d) selection = Selection.single(d.to, d.from);
    }
    if (selection === null) return;
    editor.pushJump();
    editor.setSelection(selection);
  };
  if (which === "next" || which === "prev") applyMotion(cx, run);
  else run(cx.editor);
}

// ---- Increment ----

function incrementImpl(cx: Context, sign: 1 | -1): void {
  let amount = sign * count(cx);
  const increaseBy = cx.register === "#" ? sign : 0;
  const editor = cx.editor;
  const doc = editor.doc;
  const selection = editor.selection;
  const ranges: Range[] = [];
  const changes: Change[] = [];
  let diff = 0;
  for (const range of selection.ranges) {
    const text = range.fragment(doc);
    const newFrom = range.from + diff;
    const incremented = incrementInteger(text, amount);
    amount += increaseBy;
    if (incremented === null) {
      ranges.push(new Range(newFrom, range.to + diff));
    } else {
      ranges.push(new Range(newFrom, newFrom + incremented.length));
      diff += incremented.length - text.length;
      changes.push({ from: range.from, to: range.to, insert: incremented });
    }
  }
  if (changes.length === 0) return;
  editor.apply(changes, new Selection(ranges, selection.primaryIndex));
  editor.exitSelectMode();
}

// ---- Comments ----

function toggleCommentsImpl(
  cx: Context,
  f: (
    doc: Doc,
    selection: Selection,
    line: string | null,
    block: readonly BlockCommentToken[] | null,
  ) => {
    changes: Change[];
    selection: Selection | null;
  },
): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const cursor = editor.selection.primary.cursor(doc);
  const tokens = editor.host.commentTokens(cursor);
  // The token the line is commented with, or the language's first for commenting it.
  const lineToken = getCommentToken(doc, tokens.line, doc.lineOf(cursor)) ?? tokens.line[0] ?? null;
  const result = f(doc, editor.selection, lineToken, tokens.block.length > 0 ? tokens.block : null);
  editor.apply(result.changes, result.selection ?? undefined);
  editor.exitSelectMode();
}

function toggleComments(cx: Context): void {
  toggleCommentsImpl(cx, (doc, selection, line, block) => {
    if (line !== null && block === null)
      return { changes: toggleLineComments(doc, selection, line), selection: null };
    const splitLines = splitLinesOfSelection(doc, selection);
    const blockTokens = block ?? [DEFAULT_BLOCK_TOKEN];
    const byLine = findBlockComments(blockTokens, doc, splitLines);
    // Block commented line by line is also block commented, so check this first.
    if (byLine.commented) {
      return {
        changes: createBlockCommentTransaction(true, byLine.changes).changes,
        selection: null,
      };
    }
    const whole = findBlockComments(blockTokens, doc, selection);
    if (whole.commented) {
      return {
        changes: createBlockCommentTransaction(true, whole.changes).changes,
        selection: null,
      };
    }
    if (line === null && block !== null) {
      return {
        changes: createBlockCommentTransaction(false, byLine.changes).changes,
        selection: null,
      };
    }
    return { changes: toggleLineComments(doc, selection, line), selection: null };
  });
}

function toggleLineCommentsCommand(cx: Context): void {
  toggleCommentsImpl(cx, (doc, selection, line, block) => {
    if (line === null && block !== null) {
      const result = toggleBlockComments(doc, splitLinesOfSelection(doc, selection), block);
      return { changes: result.changes, selection: null };
    }
    return { changes: toggleLineComments(doc, selection, line), selection: null };
  });
}

function toggleBlockCommentsCommand(cx: Context): void {
  toggleCommentsImpl(cx, (doc, selection, line, block) => {
    if (line !== null && block === null)
      return { changes: toggleLineComments(doc, selection, line), selection: null };
    return toggleBlockComments(doc, selection, block ?? [DEFAULT_BLOCK_TOKEN]);
  });
}

// ---- Trimming and aligning ----

function trimSelections(cx: Context): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const ranges: Range[] = [];
  for (const range of editor.selection.ranges) {
    if (range.empty || /^\s*$/.test(range.fragment(doc))) continue;
    const start = skipWhile(doc, range.from, (c) => charIsWhitespace(c)) ?? range.from;
    const end = backwardsSkipWhile(doc, range.to, (c) => charIsWhitespace(c)) ?? range.to;
    ranges.push(new Range(start, end).withDirection(range.direction));
  }
  if (ranges.length > 0) {
    const primary = editor.selection.primary;
    const idx = ranges.findIndex((r) => r.overlaps(primary));
    editor.setSelection(new Selection(ranges, idx === -1 ? ranges.length - 1 : idx));
  } else {
    collapseSelection(cx);
    keepPrimarySelection(cx);
  }
}

function alignSelections(cx: Context): void {
  const editor = cx.editor;
  const doc = editor.doc;
  const tabWidth = editor.tabWidth;
  const selection = editor.selection;
  const coords = (pos: number) => ({ row: doc.lineOf(pos), col: visualColumn(doc, pos, tabWidth) });
  const columnWidths: number[] = [];
  const coordinates: { row: number; col: number }[] = [];
  let previousLine = -1;
  let colIdx = 0;
  let runningOffset = 0;
  for (const range of selection.ranges) {
    const head = coords(range.head);
    const anchor = coords(range.anchor);
    if (head.row !== anchor.row) {
      editor.setError("align cannot work with multi line selections");
      return;
    }
    if (head.row !== previousLine) {
      colIdx = 0;
      runningOffset = 0;
      previousLine = head.row;
    }
    const width = head.col - runningOffset;
    columnWidths[colIdx] = Math.max(columnWidths[colIdx] ?? 0, width);
    coordinates.push(head);
    runningOffset += width;
    colIdx++;
  }
  const positions: number[] = [];
  let sum = 0;
  for (const w of columnWidths) {
    sum += w;
    positions.push(sum);
  }
  previousLine = -1;
  const changes: Change[] = [];
  selection.ranges.forEach((range, i) => {
    const c = at(coordinates, i);
    if (c.row !== previousLine) {
      colIdx = 0;
      runningOffset = 0;
      previousLine = c.row;
    }
    const inserts = at(positions, colIdx) - c.col - runningOffset;
    colIdx++;
    runningOffset += inserts;
    changes.push({ from: range.from, to: range.from, insert: " ".repeat(inserts) });
  });
  editor.apply(changes);
  editor.exitSelectMode();
}

function collapseSelection(cx: Context): void {
  transform(cx, (range, doc) => Range.point(range.cursor(doc)));
}

function keepPrimarySelection(cx: Context): void {
  const range = cx.editor.selection.primary;
  cx.editor.setSelection(Selection.single(range.anchor, range.head));
}

// ---- Selecting the mode ----

function selectMode(cx: Context): void {
  const editor = cx.editor;
  const doc = editor.doc;
  // Make sure selections at the end of the document are one character wide too.
  editor.setSelection(
    editor.selection.transform((range) =>
      range.empty && range.head === doc.length
        ? new Range(prevGraphemeBoundary(doc, range.anchor), range.head)
        : range,
    ),
  );
  editor.setMode("select");
}

// ---- The registry ----

function describeBinding(keys: readonly string[] | undefined, doc: string): string {
  return keys && keys.length > 0 ? `${keys.join(", ")}  ${doc}` : doc;
}

const hostAction =
  (name: HostAction): CommandFn =>
  (cx) =>
    cx.editor.host.action(name, "");

export const COMMANDS: Readonly<Record<string, CommandFn>> = {
  no_op: () => {},
  move_char_left: (cx) => moveImpl(cx, Direction.Backward, Movement.Move, "none"),
  move_char_right: (cx) => moveImpl(cx, Direction.Forward, Movement.Move, "none"),
  move_line_up: (cx) => moveImpl(cx, Direction.Backward, Movement.Move, "line"),
  move_line_down: (cx) => moveImpl(cx, Direction.Forward, Movement.Move, "line"),
  move_visual_line_up: (cx) => moveImpl(cx, Direction.Backward, Movement.Move, "visual"),
  move_visual_line_down: (cx) => moveImpl(cx, Direction.Forward, Movement.Move, "visual"),
  extend_char_left: (cx) => moveImpl(cx, Direction.Backward, Movement.Extend, "none"),
  extend_char_right: (cx) => moveImpl(cx, Direction.Forward, Movement.Extend, "none"),
  extend_line_up: (cx) => moveImpl(cx, Direction.Backward, Movement.Extend, "line"),
  extend_line_down: (cx) => moveImpl(cx, Direction.Forward, Movement.Extend, "line"),
  extend_visual_line_up: (cx) => moveImpl(cx, Direction.Backward, Movement.Extend, "visual"),
  extend_visual_line_down: (cx) => moveImpl(cx, Direction.Forward, Movement.Extend, "visual"),
  copy_selection_on_next_line: (cx) => copySelectionOnLine(cx, Direction.Forward),
  copy_selection_on_prev_line: (cx) => copySelectionOnLine(cx, Direction.Backward),
  move_next_word_start: (cx) => moveWordImpl(cx, WordMotionTarget.NextWordStart),
  move_prev_word_start: (cx) => moveWordImpl(cx, WordMotionTarget.PrevWordStart),
  move_next_word_end: (cx) => moveWordImpl(cx, WordMotionTarget.NextWordEnd),
  move_prev_word_end: (cx) => moveWordImpl(cx, WordMotionTarget.PrevWordEnd),
  move_next_long_word_start: (cx) => moveWordImpl(cx, WordMotionTarget.NextLongWordStart),
  move_prev_long_word_start: (cx) => moveWordImpl(cx, WordMotionTarget.PrevLongWordStart),
  move_next_long_word_end: (cx) => moveWordImpl(cx, WordMotionTarget.NextLongWordEnd),
  move_prev_long_word_end: (cx) => moveWordImpl(cx, WordMotionTarget.PrevLongWordEnd),
  move_next_sub_word_start: (cx) => moveWordImpl(cx, WordMotionTarget.NextSubWordStart),
  move_prev_sub_word_start: (cx) => moveWordImpl(cx, WordMotionTarget.PrevSubWordStart),
  move_next_sub_word_end: (cx) => moveWordImpl(cx, WordMotionTarget.NextSubWordEnd),
  move_prev_sub_word_end: (cx) => moveWordImpl(cx, WordMotionTarget.PrevSubWordEnd),
  extend_next_word_start: (cx) => extendWordImpl(cx, WordMotionTarget.NextWordStart),
  extend_prev_word_start: (cx) => extendWordImpl(cx, WordMotionTarget.PrevWordStart),
  extend_next_word_end: (cx) => extendWordImpl(cx, WordMotionTarget.NextWordEnd),
  extend_prev_word_end: (cx) => extendWordImpl(cx, WordMotionTarget.PrevWordEnd),
  extend_next_long_word_start: (cx) => extendWordImpl(cx, WordMotionTarget.NextLongWordStart),
  extend_prev_long_word_start: (cx) => extendWordImpl(cx, WordMotionTarget.PrevLongWordStart),
  extend_next_long_word_end: (cx) => extendWordImpl(cx, WordMotionTarget.NextLongWordEnd),
  extend_prev_long_word_end: (cx) => extendWordImpl(cx, WordMotionTarget.PrevLongWordEnd),
  extend_next_sub_word_start: (cx) => extendWordImpl(cx, WordMotionTarget.NextSubWordStart),
  extend_prev_sub_word_start: (cx) => extendWordImpl(cx, WordMotionTarget.PrevSubWordStart),
  extend_next_sub_word_end: (cx) => extendWordImpl(cx, WordMotionTarget.NextSubWordEnd),
  extend_prev_sub_word_end: (cx) => extendWordImpl(cx, WordMotionTarget.PrevSubWordEnd),
  find_till_char: (cx) => findChar(cx, Direction.Forward, false, false),
  find_next_char: (cx) => findChar(cx, Direction.Forward, true, false),
  extend_till_char: (cx) => findChar(cx, Direction.Forward, false, true),
  extend_next_char: (cx) => findChar(cx, Direction.Forward, true, true),
  till_prev_char: (cx) => findChar(cx, Direction.Backward, false, false),
  find_prev_char: (cx) => findChar(cx, Direction.Backward, true, false),
  extend_till_prev_char: (cx) => findChar(cx, Direction.Backward, false, true),
  extend_prev_char: (cx) => findChar(cx, Direction.Backward, true, true),
  repeat_last_motion: repeatLastMotion,
  replace,
  switch_case: (cx) => switchCaseImpl(cx, switchCase),
  switch_to_uppercase: (cx) => switchCaseImpl(cx, (s) => s.toUpperCase()),
  switch_to_lowercase: (cx) => switchCaseImpl(cx, (s) => s.toLowerCase()),
  page_up: (cx) => scroll(cx, pageHeight(cx), Direction.Backward, false),
  page_down: (cx) => scroll(cx, pageHeight(cx), Direction.Forward, false),
  half_page_up: (cx) => scroll(cx, Math.floor(pageHeight(cx) / 2), Direction.Backward, false),
  half_page_down: (cx) => scroll(cx, Math.floor(pageHeight(cx) / 2), Direction.Forward, false),
  page_cursor_up: (cx) => scroll(cx, pageHeight(cx), Direction.Backward, true),
  page_cursor_down: (cx) => scroll(cx, pageHeight(cx), Direction.Forward, true),
  page_cursor_half_up: (cx) => scroll(cx, Math.floor(pageHeight(cx) / 2), Direction.Backward, true),
  page_cursor_half_down: (cx) =>
    scroll(cx, Math.floor(pageHeight(cx) / 2), Direction.Forward, true),
  select_all: selectAll,
  select_regex: selectRegex,
  split_selection: splitSelection,
  split_selection_on_newline: (cx) =>
    cx.editor.setSelection(splitOnNewline(cx.editor.doc, cx.editor.selection)),
  merge_selections: (cx) => cx.editor.setSelection(cx.editor.selection.mergeRanges()),
  merge_consecutive_selections: (cx) =>
    cx.editor.setSelection(cx.editor.selection.mergeConsecutiveRanges()),
  search: (cx) => searcher(cx, Direction.Forward),
  rsearch: (cx) => searcher(cx, Direction.Backward),
  search_next: (cx) => searchNextOrPrev(cx, Movement.Move, Direction.Forward),
  search_prev: (cx) => searchNextOrPrev(cx, Movement.Move, Direction.Backward),
  extend_search_next: (cx) => searchNextOrPrev(cx, Movement.Extend, Direction.Forward),
  extend_search_prev: (cx) => searchNextOrPrev(cx, Movement.Extend, Direction.Backward),
  search_selection: (cx) => searchSelectionImpl(cx, false),
  search_selection_detect_word_boundaries: (cx) => searchSelectionImpl(cx, true),
  make_search_word_bounded: makeSearchWordBounded,
  extend_line: (cx) =>
    extendLineImpl(
      cx,
      cx.editor.selection.primary.direction === Direction.Forward ? "below" : "above",
    ),
  extend_line_below: (cx) => extendLineImpl(cx, "below"),
  extend_line_above: (cx) => extendLineImpl(cx, "above"),
  select_line_above: (cx) => selectLineImpl(cx, "above"),
  select_line_below: (cx) => selectLineImpl(cx, "below"),
  extend_to_line_bounds: extendToLineBounds,
  shrink_to_line_bounds: shrinkToLineBounds,
  delete_selection: (cx) => deleteSelectionImpl(cx, "delete", true),
  delete_selection_noyank: (cx) => deleteSelectionImpl(cx, "delete", false),
  change_selection: (cx) => deleteSelectionImpl(cx, "change", true),
  change_selection_noyank: (cx) => deleteSelectionImpl(cx, "change", false),
  collapse_selection: collapseSelection,
  flip_selections: (cx) => transform(cx, (r) => r.flip()),
  ensure_selections_forward: (cx) => transform(cx, (r) => r.withDirection(Direction.Forward)),
  insert_mode: insertMode,
  append_mode: appendMode,
  insert_at_line_start: (cx) => insertWithIndent(cx, "start"),
  insert_at_line_end: (cx) => insertWithIndent(cx, "end"),
  open_below: (cx) => open(cx, "below", true),
  open_above: (cx) => open(cx, "above", true),
  normal_mode: (cx) => cx.editor.enterNormalMode(),
  select_mode: selectMode,
  exit_select_mode: (cx) => cx.editor.exitSelectMode(),
  goto_definition: hostAction("goto_definition"),
  goto_declaration: hostAction("goto_declaration"),
  goto_type_definition: hostAction("goto_type_definition"),
  goto_implementation: hostAction("goto_implementation"),
  goto_reference: hostAction("goto_reference"),
  add_newline_above: (cx) => addNewlineImpl(cx, "above"),
  add_newline_below: (cx) => addNewlineImpl(cx, "below"),
  goto_file_start: (cx) => gotoFileStartImpl(cx, Movement.Move),
  goto_file_end: (cx) => gotoFileEndImpl(cx, Movement.Move),
  extend_to_file_start: (cx) => gotoFileStartImpl(cx, Movement.Extend),
  extend_to_file_end: (cx) => gotoFileEndImpl(cx, Movement.Extend),
  goto_window_top: (cx) => gotoWindow(cx, "top"),
  goto_window_center: (cx) => gotoWindow(cx, "center"),
  goto_window_bottom: (cx) => gotoWindow(cx, "bottom"),
  goto_last_modification: (cx) => {
    const pos = cx.editor.lastEditPos;
    if (pos === null) return;
    const doc = cx.editor.doc;
    const selection = cx.editor.selection.transform((r) =>
      r.putCursor(doc, Math.min(pos, doc.length), isSelect(cx)),
    );
    cx.editor.pushJump();
    cx.editor.setSelection(selection);
  },
  goto_line: (cx) => gotoLineImpl(cx, Movement.Move),
  goto_last_line: (cx) => gotoLastLineImpl(cx, Movement.Move),
  extend_to_last_line: (cx) => gotoLastLineImpl(cx, Movement.Extend),
  goto_first_diag: (cx) => gotoDiag(cx, "first"),
  goto_last_diag: (cx) => gotoDiag(cx, "last"),
  goto_next_diag: (cx) => gotoDiag(cx, "next"),
  goto_prev_diag: (cx) => gotoDiag(cx, "prev"),
  goto_line_start: (cx) => gotoLineStartImpl(cx, behaviour(cx)),
  goto_line_end: (cx) => gotoLineEndImpl(cx, behaviour(cx)),
  goto_column: (cx) => gotoColumnImpl(cx, Movement.Move),
  extend_to_column: (cx) => gotoColumnImpl(cx, Movement.Extend),
  goto_line_end_newline: (cx) => gotoLineEndNewlineImpl(cx, behaviour(cx)),
  goto_first_nonwhitespace: (cx) => gotoFirstNonwhitespaceImpl(cx, behaviour(cx)),
  trim_selections: trimSelections,
  extend_to_line_start: (cx) => gotoLineStartImpl(cx, Movement.Extend),
  extend_to_first_nonwhitespace: (cx) => gotoFirstNonwhitespaceImpl(cx, Movement.Extend),
  extend_to_line_end: (cx) => gotoLineEndImpl(cx, Movement.Extend),
  extend_to_line_end_newline: (cx) => gotoLineEndNewlineImpl(cx, Movement.Extend),
  signature_help: hostAction("signature_help"),
  smart_tab: smartTab,
  insert_tab: (cx) => insertTabImpl(cx, 1),
  insert_newline: insertNewline,
  insert_char_interactive: (cx) => {
    const mode = cx.editor.mode;
    insertMode(cx);
    insertSelectionInteractive(cx, mode);
  },
  append_char_interactive: (cx) => {
    const mode = cx.editor.mode;
    appendMode(cx);
    insertSelectionInteractive(cx, mode);
  },
  delete_char_backward: deleteCharBackward,
  delete_char_forward: (cx) => {
    const n = count(cx);
    deleteBySelectionInsertMode(
      cx,
      (doc, range) => {
        const pos = range.cursor(doc);
        return [pos, nthNextGraphemeBoundary(doc, pos, n)];
      },
      Direction.Forward,
    );
  },
  delete_word_backward: (cx) => {
    const n = count(cx);
    deleteBySelectionInsertMode(
      cx,
      (doc, range) => {
        const anchor = wordMove(doc, range, n, WordMotionTarget.PrevWordStart).from;
        const next = new Range(anchor, range.cursor(doc));
        // Exclude the cursor.
        const r =
          next.to === range.to && doc.length !== range.to
            ? new Range(next.from, prevGraphemeBoundary(doc, range.to))
            : next;
        return [r.from, r.to];
      },
      Direction.Backward,
    );
  },
  delete_word_forward: (cx) => {
    const n = count(cx);
    deleteBySelectionInsertMode(
      cx,
      (doc, range) => [range.cursor(doc), wordMove(doc, range, n, WordMotionTarget.NextWordEnd).to],
      Direction.Forward,
    );
  },
  kill_to_line_start: (cx) =>
    deleteBySelectionInsertMode(
      cx,
      (doc, range) => {
        const line = range.cursorLine(doc);
        const firstChar = doc.lineStart(line);
        const anchor = range.cursor(doc);
        let head: number;
        if (anchor === firstChar && line !== 0) {
          // Delete to the end of the previous line.
          head = doc.lineEnd(line - 1);
        } else {
          const pos = firstNonWhitespace(doc, line);
          // Delete to the first non-blank character if the cursor is after it.
          head = pos !== null && firstChar + pos < anchor ? firstChar + pos : firstChar;
        }
        return [head, anchor];
      },
      Direction.Backward,
    ),
  kill_to_line_end: (cx) =>
    deleteBySelectionInsertMode(
      cx,
      (doc, range) => {
        const line = range.cursorLine(doc);
        const lineEnd = doc.lineEnd(line);
        const pos = range.cursor(doc);
        // On the line ending, delete that.
        return pos === lineEnd
          ? [pos, doc.lineStart(Math.min(line + 1, doc.lines))]
          : [pos, lineEnd];
      },
      Direction.Forward,
    ),
  undo: (cx) => undoImpl(cx, false),
  redo: (cx) => undoImpl(cx, true),
  earlier: (cx) => undoImpl(cx, false),
  later: (cx) => undoImpl(cx, true),
  commit_undo_checkpoint: (cx) => cx.editor.commitUndoCheckpoint(),
  yank: (cx) => {
    yankImpl(cx.editor, defaultYankRegister(cx));
    cx.editor.exitSelectMode();
  },
  yank_to_clipboard: (cx) => {
    yankImpl(cx.editor, "+");
    cx.editor.exitSelectMode();
  },
  yank_to_primary_clipboard: (cx) => {
    yankImpl(cx.editor, "*");
    cx.editor.exitSelectMode();
  },
  yank_joined: (cx) => {
    yankJoinedImpl(cx.editor, "\n", defaultYankRegister(cx));
    cx.editor.exitSelectMode();
  },
  yank_joined_to_clipboard: (cx) => {
    yankJoinedImpl(cx.editor, "\n", "+");
    cx.editor.exitSelectMode();
  },
  yank_joined_to_primary_clipboard: (cx) => {
    yankJoinedImpl(cx.editor, "\n", "*");
    cx.editor.exitSelectMode();
  },
  yank_main_selection_to_clipboard: (cx) => {
    yankMainSelectionToRegister(cx.editor, "+");
    cx.editor.exitSelectMode();
  },
  yank_main_selection_to_primary_clipboard: (cx) => {
    yankMainSelectionToRegister(cx.editor, "*");
    cx.editor.exitSelectMode();
  },
  replace_with_yanked: async (cx) => {
    await replaceSelectionsWithRegister(cx.editor, defaultYankRegister(cx), count(cx));
    cx.editor.exitSelectMode();
  },
  replace_selections_with_clipboard: async (cx) => {
    await replaceSelectionsWithRegister(cx.editor, "+", count(cx));
    cx.editor.exitSelectMode();
  },
  replace_selections_with_primary_clipboard: async (cx) => {
    await replaceSelectionsWithRegister(cx.editor, "*", count(cx));
    cx.editor.exitSelectMode();
  },
  paste_after: async (cx) => {
    await paste(cx, defaultYankRegister(cx), "after");
    cx.editor.exitSelectMode();
  },
  paste_before: async (cx) => {
    await paste(cx, defaultYankRegister(cx), "before");
    cx.editor.exitSelectMode();
  },
  paste_clipboard_after: async (cx) => {
    await paste(cx, "+", "after");
    cx.editor.exitSelectMode();
  },
  paste_clipboard_before: async (cx) => {
    await paste(cx, "+", "before");
    cx.editor.exitSelectMode();
  },
  paste_primary_clipboard_after: async (cx) => {
    await paste(cx, "*", "after");
    cx.editor.exitSelectMode();
  },
  paste_primary_clipboard_before: async (cx) => {
    await paste(cx, "*", "before");
    cx.editor.exitSelectMode();
  },
  indent,
  unindent,
  format_selections: hostAction("format"),
  join_selections: (cx) => joinSelectionsImpl(cx, false),
  join_selections_space: (cx) => joinSelectionsImpl(cx, true),
  keep_selections: (cx) => keepOrRemoveSelections(cx, false),
  remove_selections: (cx) => keepOrRemoveSelections(cx, true),
  align_selections: alignSelections,
  keep_primary_selection: keepPrimarySelection,
  remove_primary_selection: (cx) => {
    const sel = cx.editor.selection;
    if (sel.length === 1) {
      cx.editor.setError("no selections remaining");
      return;
    }
    cx.editor.setSelection(sel.remove(sel.primaryIndex));
  },
  completion: hostAction("completion"),
  hover: hostAction("hover"),
  toggle_comments: toggleComments,
  toggle_line_comments: toggleLineCommentsCommand,
  toggle_block_comments: toggleBlockCommentsCommand,
  rotate_selections_forward: (cx) => rotateSelections(cx, Direction.Forward),
  rotate_selections_backward: (cx) => rotateSelections(cx, Direction.Backward),
  rotate_selections_first: (cx) => cx.editor.setSelection(cx.editor.selection.withPrimaryIndex(0)),
  rotate_selections_last: (cx) =>
    cx.editor.setSelection(cx.editor.selection.withPrimaryIndex(cx.editor.selection.length - 1)),
  rotate_selection_contents_forward: (cx) => reorderSelectionContents(cx, "forward"),
  rotate_selection_contents_backward: (cx) => reorderSelectionContents(cx, "backward"),
  reverse_selection_contents: (cx) => reorderSelectionContents(cx, "reverse"),
  jump_forward: (cx) => {
    const jump = cx.editor.jumps.forward(count(cx));
    if (jump) {
      cx.editor.setSelection(jump);
      cx.editor.host.scroll({
        kind: "align",
        pos: jump.primary.cursor(cx.editor.doc),
        align: "center",
      });
    }
  },
  jump_backward: (cx) => {
    const jump = cx.editor.jumps.backward(cx.editor.selection, count(cx));
    if (jump) {
      cx.editor.setSelection(jump);
      cx.editor.host.scroll({
        kind: "align",
        pos: jump.primary.cursor(cx.editor.doc),
        align: "center",
      });
    }
  },
  save_selection: (cx) => {
    cx.editor.pushJump();
    cx.editor.setStatus("Selection saved to jumplist");
  },
  select_register: selectRegister,
  insert_register: insertRegister,
  copy_between_registers: copyBetweenRegisters,
  align_view_middle: (cx) => {
    if (cx.editor.host.softWrap()) return;
    cx.editor.host.scroll({
      kind: "horizontal-center",
      pos: cx.editor.selection.primary.cursor(cx.editor.doc),
    });
  },
  align_view_top: (cx) =>
    cx.editor.host.scroll({
      kind: "align",
      pos: cx.editor.selection.primary.cursor(cx.editor.doc),
      align: "top",
    }),
  align_view_center: (cx) =>
    cx.editor.host.scroll({
      kind: "align",
      pos: cx.editor.selection.primary.cursor(cx.editor.doc),
      align: "center",
    }),
  align_view_bottom: (cx) =>
    cx.editor.host.scroll({
      kind: "align",
      pos: cx.editor.selection.primary.cursor(cx.editor.doc),
      align: "bottom",
    }),
  scroll_up: (cx) => scroll(cx, count(cx), Direction.Backward, false),
  scroll_down: (cx) => scroll(cx, count(cx), Direction.Forward, false),
  match_brackets: (cx) => {
    const editor = cx.editor;
    const doc = editor.doc;
    const selection = editor.selection.transform((range) => {
      const matched = findMatchingBracketFuzzy(doc, range.cursor(doc));
      return matched === null ? range : range.putCursor(doc, matched, isSelect(cx));
    });
    editor.pushJump();
    editor.setSelection(selection);
  },
  surround_add: surroundAdd,
  surround_replace: surroundReplace,
  surround_delete: surroundDelete,
  select_textobject_inside_paragraph: (cx) => {
    const n = count(cx);
    textobjectMotion(cx, (doc, r) => textobjectParagraph(doc, r, TextObject.Inside, n));
  },
  select_textobject_around_paragraph: (cx) => {
    const n = count(cx);
    textobjectMotion(cx, (doc, r) => textobjectParagraph(doc, r, TextObject.Around, n));
  },
  select_textobject_inside_closest_surrounding_pair: (cx) => {
    const n = count(cx);
    textobjectMotion(cx, (doc, r) => textobjectPairSurroundClosest(doc, r, TextObject.Inside, n));
  },
  select_textobject_around_closest_surrounding_pair: (cx) => {
    const n = count(cx);
    textobjectMotion(cx, (doc, r) => textobjectPairSurroundClosest(doc, r, TextObject.Around, n));
  },
  select_textobject_inside_word: (cx) =>
    textobjectMotion(cx, (doc, r) => textobjectWord(doc, r, TextObject.Inside, false)),
  select_textobject_around_word: (cx) =>
    textobjectMotion(cx, (doc, r) => textobjectWord(doc, r, TextObject.Around, false)),
  select_textobject_inside_WORD: (cx) =>
    textobjectMotion(cx, (doc, r) => textobjectWord(doc, r, TextObject.Inside, true)),
  select_textobject_around_WORD: (cx) =>
    textobjectMotion(cx, (doc, r) => textobjectWord(doc, r, TextObject.Around, true)),
  goto_next_paragraph: (cx) => gotoParaImpl(cx, moveNextParagraph),
  goto_prev_paragraph: (cx) => gotoParaImpl(cx, movePrevParagraph),
  rename_symbol: hostAction("rename_symbol"),
  select_references_to_symbol_under_cursor: hostAction("select_references_to_symbol_under_cursor"),
  code_action: hostAction("code_action"),
  increment: (cx) => incrementImpl(cx, 1),
  decrement: (cx) => incrementImpl(cx, -1),
  record_macro: recordMacro,
  replay_macro: replayMacro,
  goto_word: (cx) => jumpToWord(cx, Movement.Move),
  extend_to_word: (cx) => jumpToWord(cx, Movement.Extend),
  command_palette: (cx) => {
    const bindings = cx.bindings();
    const statics: PickerItem[] = Object.entries(STATIC_COMMANDS).map(([name, doc]) => ({
      label: name,
      detail: describeBinding(bindings.get(name), doc),
      run: (cx2) => cx2.runCommand({ kind: "static", name }),
    }));
    const typed: PickerItem[] = TYPABLE_COMMANDS.map((c) => ({
      label: `:${c.name}`,
      detail: describeBinding(bindings.get(`:${c.name}`), c.doc),
      run: (cx2) => cx2.runCommand({ kind: "typable", name: c.name, args: "" }),
    }));
    cx.openPicker("Commands", [...statics, ...typed]);
  },
  diagnostics_picker: (cx) => {
    const doc = cx.editor.doc;
    const items: PickerItem[] = cx.editor.host.diagnostics().map((d) => ({
      label: d.message.split("\n")[0] ?? "",
      detail: `line ${doc.lineOf(Math.min(d.from, doc.length)) + 1}`,
      run: (cx2) => {
        cx2.editor.pushJump();
        cx2.editor.setSelection(Selection.single(d.from, d.to));
        cx2.editor.host.scroll({ kind: "align", pos: d.from, align: "center" });
      },
    }));
    if (items.length === 0) {
      cx.editor.setStatus("No diagnostics");
      return;
    }
    cx.openPicker("Diagnostics", items);
  },
  jumplist_picker: (cx) => {
    const doc = cx.editor.doc;
    const items: PickerItem[] = [...cx.editor.jumps.entries()].reverse().map((selection) => ({
      label: selection.fragments(doc).join(" ").replace(/\s+/g, " ").slice(0, 120),
      detail: `line ${selection.primary.cursorLine(doc) + 1}`,
      run: (cx2) => {
        cx2.editor.setSelection(selection);
        cx2.editor.host.scroll({
          kind: "align",
          pos: selection.primary.cursor(cx2.editor.doc),
          align: "center",
        });
      },
    }));
    cx.openPicker("Jumplist", items);
  },
  symbol_picker: hostAction("symbol_picker"),
  lsp_or_syntax_symbol_picker: hostAction("symbol_picker"),
  command_mode: (cx) => {
    cx.editor.prompt = {
      label: ":",
      historyRegister: ":",
      input: "",
      onEvent: (_editor, input, event) =>
        event === "validate" ? cx.runCommandLine(input) : undefined,
    };
    cx.editor.onChange();
  },
};

/**
 * Helix commands Workshop doesn't have, and why, so a keymap can name them but pressing them
 * explains rather than doing nothing.
 */
export const UNSUPPORTED: Readonly<Record<string, string>> = Object.fromEntries([
  ...[
    "move_parent_node_end",
    "move_parent_node_start",
    "extend_parent_node_end",
    "extend_parent_node_start",
    "expand_selection",
    "shrink_selection",
    "select_next_sibling",
    "select_prev_sibling",
    "select_all_siblings",
    "select_all_children",
    "select_textobject_inside_type",
    "select_textobject_around_type",
    "select_textobject_inside_function",
    "select_textobject_around_function",
    "select_textobject_inside_parameter",
    "select_textobject_around_parameter",
    "select_textobject_inside_comment",
    "select_textobject_around_comment",
    "select_textobject_inside_test",
    "select_textobject_around_test",
    "select_textobject_inside_entry",
    "select_textobject_around_entry",
    "goto_next_function",
    "goto_prev_function",
    "goto_next_class",
    "goto_prev_class",
    "goto_next_parameter",
    "goto_prev_parameter",
    "goto_next_comment",
    "goto_prev_comment",
    "goto_next_test",
    "goto_prev_test",
    "goto_next_xml_element",
    "goto_prev_xml_element",
    "goto_next_entry",
    "goto_prev_entry",
    "syntax_symbol_picker",
    "syntax_workspace_symbol_picker",
  ].map((name) => [name, "needs a syntax tree, which Workshop's editor doesn't have"]),
  ...[
    "goto_next_change",
    "goto_prev_change",
    "goto_first_change",
    "goto_last_change",
    "select_textobject_inside_change",
    "select_textobject_around_change",
    "changed_file_picker",
  ].map((name) => [name, "needs version control changes, which Workshop doesn't show"]),
  ...[
    "file_picker",
    "file_picker_in_current_buffer_directory",
    "file_picker_in_current_directory",
    "file_explorer",
    "file_explorer_in_current_buffer_directory",
    "file_explorer_in_current_directory",
    "buffer_picker",
    "goto_file",
    "goto_file_hsplit",
    "goto_file_vsplit",
    "goto_last_accessed_file",
    "goto_last_modified_file",
    "goto_next_buffer",
    "goto_previous_buffer",
    "global_search",
    "global_search_fixed_strings",
    "workspace_symbol_picker",
    "lsp_or_syntax_workspace_symbol_picker",
    "workspace_diagnostics_picker",
    "last_picker",
  ].map((name) => [name, "works across files, and Workshop edits one at a time"]),
  ...[
    "jump_view_right",
    "jump_view_left",
    "jump_view_up",
    "jump_view_down",
    "swap_view_right",
    "swap_view_left",
    "swap_view_up",
    "swap_view_down",
    "transpose_view",
    "rotate_view",
    "rotate_view_reverse",
    "hsplit",
    "hsplit_new",
    "vsplit",
    "vsplit_new",
    "wclose",
    "wonly",
  ].map((name) => [name, "works with splits, and Workshop has one view"]),
  ...[
    "shell_pipe",
    "shell_pipe_to",
    "shell_insert_output",
    "shell_append_output",
    "shell_keep_pipe",
    "suspend",
  ].map((name) => [name, "runs shell commands, which Workshop's editor never does"]),
  ...[
    "dap_launch",
    "dap_restart",
    "dap_toggle_breakpoint",
    "dap_continue",
    "dap_pause",
    "dap_step_in",
    "dap_step_out",
    "dap_next",
    "dap_variables",
    "dap_terminate",
    "dap_edit_condition",
    "dap_edit_log",
    "dap_switch_thread",
    "dap_switch_stack_frame",
    "dap_enable_exceptions",
    "dap_disable_exceptions",
  ].map((name) => [name, "needs a debugger, which Workshop doesn't have"]),
  ...["goto_next_tabstop", "goto_prev_tabstop"].map((name) => [
    name,
    "needs snippets with placeholders, which Workshop's snippets don't have",
  ]),
]);
