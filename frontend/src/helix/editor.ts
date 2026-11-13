// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): the parts of helix-view's editor,
// document, view and register modules that commands use.

import {
  type ChangeDesc,
  ChangeSet,
  EditorSelection,
  type EditorState,
  StateEffect,
  StateField,
  Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import { type Change, mapSelection, normalizeChanges } from "./changes";
import type { BlockCommentToken } from "./comment";
import { helixUndoGroup } from "./history";
import type { Mode } from "./keymap";
import type { Key } from "./keys";
import type { Picker } from "./picker";
import { Range, Selection } from "./selection";
import { at, Doc, isEmptyLine, prevGraphemeBoundary } from "./text";

/** Options from Helix's `[editor]` config that Workshop's Helix keybindings follow. */
export interface HelixOptions {
  /** Lines kept between the cursor and the top or bottom of the view. */
  readonly scrolloff: number;
  /** Search case-insensitively unless the search has a capital letter. */
  readonly smartCase: boolean;
  /** Searches carry on from the other end of the file. */
  readonly wrapAround: boolean;
  /** Typing an opening bracket or quote also types the closing one. */
  readonly autoPairs: boolean;
  /** Tab moves past the end of the enclosing brackets when there's text before the cursor. */
  readonly smartTab: boolean;
  readonly lineNumbers: "absolute" | "relative";
  /** Colour the mode shown under the code, and the cursor, by mode. */
  readonly colorModes: boolean;
  readonly cursorShape: Readonly<Record<Mode, CursorShape>>;
  /** The characters `gw` labels words with. */
  readonly jumpLabelAlphabet: string;
}

export type CursorShape = "block" | "bar" | "underline" | "hidden";

export const DEFAULT_OPTIONS: HelixOptions = {
  scrolloff: 5,
  smartCase: true,
  wrapAround: true,
  autoPairs: true,
  smartTab: false,
  lineNumbers: "absolute",
  colorModes: false,
  cursorShape: { normal: "block", select: "block", insert: "block" },
  jumpLabelAlphabet: "abcdefghijklmnopqrstuvwxyz",
};

export type Severity = "info" | "error";

export interface Status {
  readonly message: string;
  readonly severity: Severity;
}

/** A diagnostic from the language server, as a range of the text. */
export interface HelixDiagnostic {
  readonly from: number;
  readonly to: number;
  readonly message: string;
}

/** How the view should scroll after a command, as Helix's `align_view` and scrolling do. */
export type ScrollRequest =
  | { readonly kind: "align"; readonly pos: number; readonly align: "top" | "center" | "bottom" }
  | { readonly kind: "lines"; readonly lines: number }
  | { readonly kind: "horizontal-center"; readonly pos: number };

/** What the editor needs from where it's shown, which tests stand in for. */
export interface Host {
  readonly state: EditorState;
  dispatch(spec: TransactionSpec): void;
  /** The first and last lines in view, and how many lines the view is tall. */
  viewport(): { readonly firstLine: number; readonly lastLine: number; readonly height: number };
  scroll(request: ScrollRequest): void;
  /** Whether long lines wrap, which makes `j` and `k` move by displayed lines. */
  softWrap(): boolean;
  setSoftWrap(enabled: boolean): void;
  /**
   * Where moving up or down by displayed lines from `pos` lands, keeping to `goal` pixels from the
   * left, or null when lines don't wrap.
   */
  moveVisually(
    pos: number,
    forward: boolean,
    goal: number | null,
  ): { pos: number; goal: number } | null;
  readClipboard(): Promise<string>;
  writeClipboard(text: string): Promise<void>;
  diagnostics(): readonly HelixDiagnostic[];
  /**
   * The indentation the language would give a new line broken at `pos`, in columns, or null if
   * it has no opinion.
   */
  languageIndent(pos: number): number | null;
  /** The tokens that start a line comment and surround a block comment in the language. */
  commentTokens(pos: number): {
    readonly line: readonly string[];
    readonly block: readonly BlockCommentToken[];
  };
  /** Undoes the last change, returning whether there was one. */
  undo(): boolean;
  redo(): boolean;
  /** Runs an action Workshop provides itself, such as saving or a language server request. */
  action(name: HostAction, args: string): Promise<void> | void;
  /** The file's name, as register `%` reads it. */
  readonly documentName: string;
}

export type HostAction =
  | "write"
  | "reload"
  | "format"
  | "hover"
  | "goto_definition"
  | "goto_declaration"
  | "goto_type_definition"
  | "goto_implementation"
  | "goto_reference"
  | "rename_symbol"
  | "signature_help"
  | "completion"
  | "select_references_to_symbol_under_cursor"
  | "code_action"
  | "symbol_picker";

export enum IndentStyleKind {
  Tabs,
  Spaces,
}

export type IndentStyle =
  | { kind: IndentStyleKind.Tabs }
  | { kind: IndentStyleKind.Spaces; n: number };

export function indentString(style: IndentStyle): string {
  return style.kind === IndentStyleKind.Tabs
    ? "\t"
    : " ".repeat(Math.min(16, Math.max(1, style.n)));
}

export function indentWidth(style: IndentStyle, tabWidth: number): number {
  return style.kind === IndentStyleKind.Tabs ? tabWidth : style.n;
}

const MAX_INDENT = 16;

/** Guesses the indentation a document uses from how much its lines are indented by. */
export function autoDetectIndentStyle(doc: Doc): IndentStyle | null {
  const histogram = new Array<number>(MAX_INDENT + 1).fill(0);
  let prevIsTabs = false;
  let prevLeading = 0;
  outer: for (let line = 0; line < Math.min(doc.lines, 1000); line++) {
    const text = doc.line(line);
    const first = text[0];
    let isTabs: boolean;
    if (first === "\t") {
      isTabs = true;
    } else if (first === " ") {
      isTabs = false;
    } else if (first === "\n" || first === "\r") {
      continue;
    } else {
      prevIsTabs = false;
      prevLeading = 0;
      continue;
    }
    let leading = 1;
    let done = false;
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      if (c === "\t" && isTabs && !done) {
        leading++;
      } else if (c === " " && !isTabs && !done) {
        leading++;
      } else if (c === "\n" || c === "\r") {
        continue outer;
      } else if (c === " " || c === "\t") {
        done = true;
      } else {
        break;
      }
      if (leading > 256) continue outer;
    }
    if ((prevIsTabs === isTabs || prevLeading === 0) && prevLeading < leading) {
      const bucket = isTabs ? 0 : leading - prevLeading;
      if (bucket <= MAX_INDENT) histogram[bucket] = at(histogram, bucket) + 1;
    }
    prevIsTabs = isTabs;
    prevLeading = leading;
  }
  histogram[0] = at(histogram, 0) * 2;
  // Single spaces are often used in comments, and rarely as indentation.
  if (at(histogram, 1) > 1) histogram[1] = Math.floor(at(histogram, 1) / 2);

  let indent = 0;
  for (let i = 1; i < histogram.length; i++)
    if (at(histogram, i) > at(histogram, indent)) indent = i;
  const freq = at(histogram, indent);
  const freq2 = Math.max(...histogram.filter((_, i) => i !== indent));
  if (freq >= 1 && freq2 / freq < 0.66) {
    return indent === 0
      ? { kind: IndentStyleKind.Tabs }
      : { kind: IndentStyleKind.Spaces, n: indent };
  }
  return null;
}

// ---- Registers ----

/**
 * Helix's registers. Most hold the values they're given; `_` holds nothing, `#`, `.` and `%` read
 * the selection's indices and contents and the file's name, and `+` and `*` are the clipboard,
 * which in a browser are the same one.
 */
export class Registers {
  private readonly inner = new Map<string, string[]>();
  /** The register searches went to last, which `n` and `N` search with. */
  lastSearchRegister = "/";

  constructor(private readonly editor: HelixEditor) {}

  /** The values, first to last, or null if the register is empty. */
  async read(name: string): Promise<string[] | null> {
    if (name === "+" || name === "*") return this.readClipboard(name);
    return this.readSync(name);
  }

  /** Reads any register but the clipboard, which can only be read asynchronously. */
  readSync(name: string): string[] | null {
    switch (name) {
      case "_":
        return [];
      case "#":
        return this.editor.selection.ranges.map((_, i) => String(i + 1));
      case ".":
        return this.editor.selection.fragments(this.editor.doc);
      case "%":
        return [this.editor.host.documentName];
      case "+":
      case "*":
        throw new Error("the clipboard registers can only be read asynchronously");
      default:
        return this.inner.get(name) ?? null;
    }
  }

  first(name: string): string | null {
    return this.readSync(name)?.[0] ?? null;
  }

  private async readClipboard(name: string): Promise<string[]> {
    const saved = this.inner.get(name);
    let contents: string;
    try {
      contents = await this.editor.host.readClipboard();
    } catch {
      // Reading isn't allowed or supported, so what was yanked here is all there is.
      return saved ?? [];
    }
    // When pasting what was just yanked, use the values as they were, so several selections
    // paste into several selections.
    if (saved && contentsAreSaved(saved, contents)) return saved;
    return [contents];
  }

  write(name: string, values: string[]): void {
    switch (name) {
      case "_":
        return;
      case "#":
      case ".":
      case "%":
        throw new RegisterError(`Register ${name} does not support writing`);
      case "+":
      case "*":
        this.inner.set(name, values);
        this.editor.writeClipboard(values.join("\n"));
        return;
      default:
        this.inner.set(name, values);
    }
  }

  /** Adds a value before the others, as searches and command lines are remembered. */
  push(name: string, value: string): void {
    switch (name) {
      case "_":
        return;
      case "#":
      case ".":
      case "%":
        throw new RegisterError(`Register ${name} does not support pushing`);
      case "+":
      case "*": {
        const saved = this.inner.get(name) ?? [];
        this.inner.set(name, [value, ...saved]);
        this.editor.writeClipboard([value, ...saved].join("\n"));
        return;
      }
      default:
        this.inner.set(name, [value, ...(this.inner.get(name) ?? [])]);
    }
  }

  clear(name: string): boolean {
    return this.inner.delete(name);
  }

  clearAll(): void {
    this.inner.clear();
  }

  /** The registers with something in, and a preview of each, for the register picker. */
  preview(): [string, string][] {
    const out: [string, string][] = [];
    for (const [name, values] of this.inner) {
      if (name === "+" || name === "*") continue;
      out.push([name, values[0]?.split("\n")[0] ?? ""]);
    }
    out.sort(([a], [b]) => a.localeCompare(b));
    out.push(["_", "<empty>"], ["#", "<selection indices>"], [".", "<selection contents>"]);
    out.push(["%", "<document path>"], ["+", "<system clipboard>"], ["*", "<primary clipboard>"]);
    return out;
  }
}

export class RegisterError extends Error {}

function contentsAreSaved(saved: readonly string[], contents: string): boolean {
  const [first, ...others] = saved;
  if (first === undefined) return contents === "";
  if (!contents.startsWith(first)) return false;
  let rest = contents.slice(first.length);
  for (const value of others) {
    if (!rest.startsWith(`\n${value}`)) return false;
    rest = rest.slice(1 + value.length);
  }
  return true;
}

// ---- Jumps ----

const JUMP_LIST_CAPACITY = 30;

class JumpList {
  private jumps: Selection[];
  private current = 0;

  constructor(initial: Selection) {
    this.jumps = [initial];
  }

  push(jump: Selection): void {
    this.pushImpl(jump);
  }

  private pushImpl(jump: Selection): number {
    let removed = 0;
    this.jumps.length = Math.min(this.jumps.length, this.current);
    const last = this.jumps[this.jumps.length - 1];
    if (!last?.equals(jump)) {
      while (this.jumps.length >= JUMP_LIST_CAPACITY) {
        this.jumps.shift();
        removed++;
      }
      this.jumps.push(jump);
      this.current = this.jumps.length;
    }
    return removed;
  }

  forward(count: number): Selection | null {
    if (this.current + count < this.jumps.length) {
      this.current += count;
      return at(this.jumps, this.current);
    }
    return null;
  }

  backward(selection: Selection, count: number): Selection | null {
    let current = this.current - count;
    if (current < 0) return null;
    if (this.current === this.jumps.length) {
      const removed = this.pushImpl(selection);
      current = Math.max(0, current - removed);
    }
    this.current = current;
    // Avoid jumping to where the selection already is.
    const jump = this.jumps[this.current];
    if (jump === undefined) return null;
    if (jump.equals(selection)) {
      if (this.current === 0) return null;
      this.current--;
    }
    return this.jumps[this.current] ?? null;
  }

  /** Maps stored jumps through a change to the text. */
  mapThrough(map: (pos: number, assoc: -1 | 1) => number, doc: Doc): void {
    this.jumps = this.jumps.map((j) =>
      j
        .transform((r) =>
          r.anchor <= r.head
            ? new Range(map(r.anchor, 1), map(r.head, -1))
            : new Range(map(r.anchor, -1), map(r.head, 1)),
        )
        .ensureInvariants(doc),
    );
  }

  entries(): readonly Selection[] {
    return this.jumps;
  }
}

// ---- Prompts ----

export type PromptEvent = "update" | "validate" | "abort";

/** A line of text asked for under the code, such as a search. */
export interface Prompt {
  readonly label: string;
  /** Where past entries are kept, which up and down step through. */
  readonly historyRegister: string | null;
  readonly onEvent: (
    editor: HelixEditor,
    input: string,
    event: PromptEvent,
  ) => void | Promise<void>;
  /** What's typed so far, kept up to date by the view. */
  input: string;
  /** Text to start the prompt with. */
  readonly initial?: string;
}

/** Help shown for the keys that can come next, or about registers. */
export interface Info {
  readonly title: string;
  readonly body: readonly (readonly [string, string])[];
  /**
   * Help with which keys come next, which a phone leaves out for room, or text to read, such as
   * hover documentation. Help by default.
   */
  readonly kind?: "keys" | "text";
  /** Markdown to show in place of the body, such as hover documentation. */
  readonly markdown?: string;
}

/** One `gw` label: the two characters to type and the range they select. */
export interface JumpLabel {
  readonly from: number;
  readonly label: string;
}

// ---- The editor ----

/**
 * The user events of transactions Helix commands make, so the view can tell them from others.
 * Changes count as typing, so CodeMirror's history joins them into Helix's undo steps.
 */
export const HELIX_CHANGE_EVENT = "input.type.helix";
export const HELIX_SELECT_EVENT = "select.helix";

export function isHelixTransaction(tr: Transaction): boolean {
  return tr.isUserEvent(HELIX_CHANGE_EVENT) || tr.isUserEvent(HELIX_SELECT_EVENT);
}

/**
 * The state Helix commands work on: the document and selection, held in the host's CodeMirror
 * state, and everything else Helix keeps, such as the mode, registers and jumps.
 */
export class HelixEditor {
  mode: Mode = "normal";
  readonly registers: Registers = new Registers(this);
  readonly jumps: JumpList;
  /** The last motion, which `A-.` repeats. */
  lastMotion: ((editor: HelixEditor) => void) | null = null;
  /** The count typed so far, before a command. */
  count: number | null = null;
  /** The register chosen with `"`, for the next command. */
  selectedRegister: string | null = null;
  macroRecording: { register: string; keys: Key[] } | null = null;
  readonly macroReplaying: string[] = [];
  status: Status | null = null;
  autoinfo: Info | null = null;
  prompt: Prompt | null = null;
  picker: Picker | null = null;
  jumpLabels: readonly JumpLabel[] = [];
  /** Moves the cursor back a character on leaving insert mode, after appending. */
  restoreCursor = false;
  /** The changes made since entering insert mode, which decide whether to restore indentation. */
  insertChanges: Change[][] = [];
  /** The last change, for `g.`. */
  lastEditPos: number | null = null;
  options: HelixOptions;
  /** The indentation detected in the document, if any. */
  private detectedIndent: IndentStyle | null | undefined;
  readonly defaultIndent: IndentStyle;
  /** The undo step changes are in now; changes in the same step undo together. */
  private undoGroup = 0;
  /** Called whenever something shown changes, such as the mode or status. */
  onChange: () => void = () => {};

  private cachedDoc: Doc | null = null;

  constructor(
    readonly host: Host,
    options: Partial<HelixOptions> = {},
    defaultIndent: IndentStyle = { kind: IndentStyleKind.Spaces, n: 4 },
  ) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.defaultIndent = defaultIndent;
    this.jumps = new JumpList(this.selection);
  }

  get doc(): Doc {
    const text = this.host.state.doc;
    if (this.cachedDoc?.text !== text) {
      this.cachedDoc = new Doc(text);
      this.detectedIndent = undefined;
    }
    return this.cachedDoc;
  }

  get selection(): Selection {
    return helixSelection(this.host.state);
  }

  get tabWidth(): number {
    return this.host.state.tabSize;
  }

  get indentStyle(): IndentStyle {
    if (this.detectedIndent === undefined) this.detectedIndent = autoDetectIndentStyle(this.doc);
    return this.indentOverride ?? this.detectedIndent ?? this.defaultIndent;
  }

  /** Set with `:indent-style`. */
  indentOverride: IndentStyle | null = null;

  get indentUnit(): string {
    return indentString(this.indentStyle);
  }

  get indentWidth(): number {
    return indentWidth(this.indentStyle, this.tabWidth);
  }

  /** Sets the selection, which is always at least one character wide, as Helix keeps it. */
  setSelection(selection: Selection): void {
    const doc = this.doc;
    const fixed = selection.ensureInvariants(doc);
    if (fixed.equals(this.selection) && sameGoals(fixed, this.selection)) return;
    this.host.dispatch({
      ...this.selectionSpec(fixed, this.mode),
      userEvent: HELIX_SELECT_EVENT,
      // Moving the selection is no undo step of its own, and mustn't split the one it's in, as
      // a key bound to several commands is one step.
      annotations: Transaction.addToHistory.of(false),
    });
  }

  /**
   * Changes the text, then sets the selection to `selection` or, without one, maps it through
   * the changes as Helix does.
   */
  apply(changes: readonly Change[], selection?: Selection): void {
    const doc = this.doc;
    const normalized = normalizeChanges(changes, doc.length);
    const oldSelection = this.selection;
    if (normalized.length === 0) {
      if (selection) this.setSelection(selection);
      return;
    }
    const changeSet = ChangeSet.of(
      normalized.map((c) => ({ from: c.from, to: c.to, insert: c.insert })),
      doc.length,
    );
    const newText = changeSet.apply(doc.text);
    const newDoc = new Doc(newText);
    const mapped = (selection ?? mapSelection(normalized, oldSelection)).ensureInvariants(newDoc);
    if (this.mode === "insert") this.insertChanges.push(normalized);
    this.host.dispatch({
      changes: changeSet,
      ...this.selectionSpec(mapped, this.mode, newDoc),
      userEvent: HELIX_CHANGE_EVENT,
      annotations: helixUndoGroup.of(this.undoGroup),
    });
    // After the dispatch, which maps the previous one through these changes.
    const last = at(normalized, normalized.length - 1);
    this.lastEditPos = changeSet.mapPos(last.from) + last.insert.length;
  }

  /**
   * Keeps what the editor remembers about positions, such as jumps, in step with a change to the
   * text from anywhere, including undo. Hosts call this for every change.
   */
  mapThroughChanges(changes: ChangeDesc): void {
    if (changes.empty) return;
    const doc = this.doc;
    this.jumps.mapThrough((pos, assoc) => changes.mapPos(pos, assoc), doc);
    if (this.lastEditPos !== null)
      this.lastEditPos = Math.min(changes.mapPos(this.lastEditPos), doc.length);
  }

  /** Ends the current undo step, so what comes next undoes separately. */
  commitUndoCheckpoint(): void {
    this.undoGroup++;
  }

  /** Records the selection on the jump list, as Helix's `push_jump` does. */
  pushJump(): void {
    this.jumps.push(this.selection);
  }

  setStatus(message: string): void {
    this.status = { message, severity: "info" };
    this.onChange();
  }

  setError(message: string): void {
    this.status = { message, severity: "error" };
    this.onChange();
  }

  setMode(mode: Mode): void {
    if (this.mode === mode) return;
    const wasInsert = this.mode === "insert";
    const selection = this.selection;
    this.mode = mode;
    // Insert mode keeps CodeMirror's selection collapsed to the cursors, so it's back to Helix's
    // own ranges on leaving it.
    if (wasInsert !== (mode === "insert")) {
      this.host.dispatch({
        ...this.selectionSpec(selection, mode),
        userEvent: HELIX_SELECT_EVENT,
        annotations: Transaction.addToHistory.of(false),
      });
    }
    this.onChange();
  }

  /**
   * How CodeMirror holds `selection` in `mode`. In insert mode its selection is just the cursors,
   * where the browser, and a phone's keyboard in particular, then makes any change of its own,
   * as typing goes at Helix's cursors; Helix's ranges are kept beside it.
   */
  private selectionSpec(
    selection: Selection,
    mode: Mode,
    doc: Doc = this.doc,
  ): Pick<TransactionSpec, "selection" | "effects"> {
    if (mode !== "insert") {
      return { selection: toEditorSelection(selection), effects: setInsertSelection.of(null) };
    }
    return {
      selection: toEditorSelection(selection.cursors(doc)),
      effects: setInsertSelection.of(selection),
    };
  }

  enterInsertMode(): void {
    this.insertChanges = [];
    this.setMode("insert");
  }

  exitSelectMode(): void {
    if (this.mode === "select") this.setMode("normal");
  }

  /** Leaves insert or select mode, as Helix's `enter_normal_mode` does. */
  enterNormalMode(): void {
    if (this.mode === "normal") return;
    const wasInsert = this.mode === "insert";
    this.setMode("normal");
    if (wasInsert) this.tryRestoreIndent();
    if (this.restoreCursor) {
      const doc = this.doc;
      this.setSelection(
        this.selection.transform((range) => {
          let head = range.to;
          if (range.head > range.anchor) head = prevGraphemeBoundary(doc, head);
          return new Range(range.from, head);
        }),
      );
      this.restoreCursor = false;
    }
  }

  /**
   * Removes the indentation of a new line left blank, when all insert mode did was start it, as
   * after `o` then escape.
   */
  private tryRestoreIndent(): void {
    const changes = this.insertChanges;
    this.insertChanges = [];
    const [only, ...more] = changes;
    if (only === undefined || more.length > 0 || only.length !== 1) return;
    const change = at(only, 0);
    const doc = this.doc;
    const range = this.selection.primary;
    const pos = range.cursor(doc);
    const line = range.cursorLine(doc);
    const lineEnd = doc.lineEnd(line);
    const inserted = change.insert;
    if (
      change.from === change.to &&
      change.from + inserted.length === pos &&
      inserted.startsWith("\n") &&
      /^[ \t]*$/.test(inserted.slice(1)) &&
      pos === lineEnd
    ) {
      this.apply([{ from: doc.lineStart(line), to: pos, insert: "" }]);
    }
  }

  writeClipboard(text: string): void {
    this.host.writeClipboard(text).catch((e: unknown) => {
      this.setError(
        `Couldn't copy to the clipboard: ${e instanceof Error ? e.message : String(e)}`,
      );
    });
  }

  /** The indentation for a new line after `line`, broken at `pos`. */
  indentForNewline(line: number, pos: number): string {
    const fromLanguage = this.host.languageIndent(pos);
    if (fromLanguage !== null) return this.indentOfColumns(fromLanguage);
    // Helix's fallback, without a syntax tree: the current line's indentation, in whole levels.
    const level = indentLevelForLine(this.doc, line, this.tabWidth, this.indentWidth);
    return this.indentUnit.repeat(level);
  }

  /** Indentation `columns` wide, in the document's style. */
  indentOfColumns(columns: number): string {
    const style = this.indentStyle;
    if (style.kind === IndentStyleKind.Spaces) return " ".repeat(columns);
    return "\t".repeat(Math.floor(columns / this.tabWidth)) + " ".repeat(columns % this.tabWidth);
  }

  isLineEmpty(line: number): boolean {
    return isEmptyLine(this.doc, line);
  }
}

function indentLevelForLine(doc: Doc, line: number, tabWidth: number, width: number): number {
  let len = 0;
  for (const ch of doc.line(line)) {
    if (ch === "\t") {
      len += tabWidth - (len % tabWidth);
    } else if (ch === " ") {
      len++;
    } else {
      break;
    }
  }
  return Math.floor(len / width);
}

function sameGoals(a: Selection, b: Selection): boolean {
  return a.ranges.every((r, i) => r.goalColumn === b.ranges[i]?.goalColumn);
}

const setInsertSelection = StateEffect.define<Selection | null>();

/** The changes in a CodeMirror change set, as Helix's commands describe changes. */
function changesOf(tr: Transaction): Change[] {
  const out: Change[] = [];
  tr.changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({ from: fromA, to: toA, insert: inserted.toString() });
  });
  return out;
}

/**
 * Helix's selection while in insert mode, when CodeMirror's is collapsed to its cursors. Follows
 * changes made other than by Helix's commands, as Helix maps selections, and taps, which put a
 * cursor where they are.
 */
export const insertSelectionField = StateField.define<Selection | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setInsertSelection)) return e.value;
    if (value === null || isHelixTransaction(tr)) return value;
    const doc = new Doc(tr.newDoc);
    if (tr.selection) return fromEditorSelection(tr.newSelection).ensureInvariants(doc);
    if (!tr.docChanged) return value;
    return mapSelection(changesOf(tr), value).ensureInvariants(doc);
  },
});

/** Helix's selection in a state, wherever it's kept. */
export function helixSelection(state: EditorState): Selection {
  return state.field(insertSelectionField, false) ?? fromEditorSelection(state.selection);
}

export function fromEditorSelection(selection: EditorSelection): Selection {
  return new Selection(
    selection.ranges.map((r) => new Range(r.anchor, r.head, r.goalColumn ?? null)),
    selection.mainIndex,
  );
}

export function toEditorSelection(selection: Selection): EditorSelection {
  return EditorSelection.create(
    selection.ranges.map((r) => EditorSelection.range(r.anchor, r.head, r.goalColumn ?? undefined)),
    selection.primaryIndex,
  );
}
