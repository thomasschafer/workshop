// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Test helpers, ported from Helix (https://github.com/helix-editor/helix): helix-core's test.rs,
// which writes a selection into text, such as `#[f|]#oo` for a cursor on the `f`.

import { redo, undo } from "@codemirror/commands";
import {
  type ChangeDesc,
  EditorState,
  type Transaction,
  type TransactionSpec,
} from "@codemirror/state";
import {
  type HelixDiagnostic,
  HelixEditor,
  type HelixOptions,
  type Host,
  insertSelectionField,
  type ScrollRequest,
  toEditorSelection,
} from "./editor";
import { KeyHandler } from "./handler";
import { helixHistory } from "./history";
import { defaultKeymaps, type KeyTrieNode, type Mode } from "./keymap";
import { parseMacro } from "./keys";
import { type LanguageConfig, PLAIN_TEXT } from "./languages";
import { Range, Selection } from "./selection";
import { graphemes } from "./text";

/**
 * Reads text with selections written into it: `#[` and `]#` around the primary range, `#(` and
 * `)#` around others, with `|` beside the bracket where the head is. A line ending at the end of
 * a selection followed by the same line ending stands for one, so a cursor can sit on it.
 */
export function print(s: string): { text: string; selection: Selection } {
  let primary: number | null = null;
  const ranges: Range[] = [];
  let left = "";
  const g = graphemes(s);
  let i = 0;
  outer: while (i < g.length) {
    const c = g[i++] as string;
    const start = left.length;
    if (c !== "#") {
      left += c;
      continue;
    }
    const open = g[i++];
    let isPrimary: boolean;
    let close: string;
    if (open === "[") {
      isPrimary = true;
      close = "]";
    } else if (open === "(") {
      isPrimary = false;
      close = ")";
    } else if (open === undefined) {
      break;
    } else {
      left += `#${open}`;
      continue;
    }
    if (isPrimary && primary !== null) throw new Error(`primary \`#[\` already appeared in ${s}`);
    const headAtStart = g[i] === "|";
    if (headAtStart) i++;
    while (i < g.length) {
      const ch = g[i++] as string;
      const next = g[i];
      let prev = lastGrapheme(left);
      if (!(ch === close && next === "#")) {
        left += ch;
        continue;
      }
      if (!headAtStart) {
        if (prev !== "|") {
          left += ch;
          continue;
        }
        left = left.slice(0, -1);
        prev = lastGrapheme(left);
      }
      i++; // the `#`
      // Skip an explicit line ending inside the selection.
      if ((prev === "\r\n" || prev === "\n") && g[i] === prev) i++;
      if (isPrimary) primary = ranges.length;
      ranges.push(headAtStart ? new Range(left.length, start) : new Range(start, left.length));
      continue outer;
    }
    throw new Error(`missing end of a selection in ${s}`);
  }
  if (primary === null) throw new Error(`missing primary \`#[|]#\` in ${s}`);
  return { text: left, selection: new Selection(ranges, primary) };
}

function lastGrapheme(s: string): string | undefined {
  return graphemes(s).at(-1);
}

/** Writes text with its selection in, as `print` reads it. */
export function plain(text: string, selection: Selection): string {
  const marks: [number, number, string][] = [];
  selection.ranges.forEach((range, i) => {
    const primary = i === selection.primaryIndex;
    const [open, close] = primary ? ["#[", "]#"] : ["#(", ")#"];
    if (range.head < range.anchor) {
      marks.push([range.head, 0, `${open}|`], [range.anchor, 1, close]);
    } else {
      marks.push([range.anchor, 0, open], [range.head, 1, `|${close}`]);
    }
  });
  // Closing marks come before opening ones at the same place.
  marks.sort((a, b) => a[0] - b[0] || b[1] - a[1]);
  let out = "";
  let last = 0;
  for (const [pos, , mark] of marks) {
    out += text.slice(last, pos) + mark;
    last = pos;
  }
  return out + text.slice(last);
}

/** A host for tests, holding the editor's state, as a view would, without one. */
export class TestHost implements Host {
  state: EditorState;
  clipboard = "";
  scrolls: ScrollRequest[] = [];
  actions: string[] = [];
  language: LanguageConfig = PLAIN_TEXT;
  diagnosticList: HelixDiagnostic[] = [];
  wrap = false;
  readonly documentName = "[scratch]";

  constructor(text: string, selection: Selection) {
    this.state = EditorState.create({
      doc: text,
      selection: toEditorSelection(selection),
      extensions: [
        helixHistory(),
        insertSelectionField,
        EditorState.allowMultipleSelections.of(true),
      ],
    });
  }

  /** Told of every change, as a view tells the editor. */
  onChanges: (changes: ChangeDesc) => void = () => {};

  dispatch(spec: TransactionSpec): void {
    this.apply(this.state.update(spec));
  }

  private apply(tr: Transaction): void {
    this.state = tr.state;
    this.onChanges(tr.changes);
  }

  viewport() {
    const height = 40;
    return { firstLine: 0, lastLine: Math.min(this.state.doc.lines - 1, height - 1), height };
  }

  scroll(request: ScrollRequest): void {
    this.scrolls.push(request);
  }

  softWrap(): boolean {
    return this.wrap;
  }

  setSoftWrap(enabled: boolean): void {
    this.wrap = enabled;
  }

  moveVisually(): null {
    return null;
  }

  async readClipboard(): Promise<string> {
    return this.clipboard;
  }

  async writeClipboard(text: string): Promise<void> {
    this.clipboard = text;
  }

  diagnostics(): readonly HelixDiagnostic[] {
    return this.diagnosticList;
  }

  languageIndent(): null {
    return null;
  }

  commentTokens() {
    return { line: this.language.lineComments, block: this.language.blockComments };
  }

  undo(): boolean {
    return undo(this.target());
  }

  redo(): boolean {
    return redo(this.target());
  }

  private target() {
    return {
      state: this.state,
      dispatch: (tr: Transaction) => this.apply(tr),
    };
  }

  action(name: string, args: string): void {
    this.actions.push(args ? `${name} ${args}` : name);
  }
}

export interface Harness {
  host: TestHost;
  editor: HelixEditor;
  handler: KeyHandler;
  /** Presses keys, written as a macro, such as `ihello<esc>`. */
  keys(keys: string): Promise<void>;
  /** The text with the selection written in. */
  state(): string;
  mode(): Mode;
}

/** An editor on `annotated` text, as `print` reads it. */
export function harness(
  annotated: string,
  options: {
    options?: Partial<HelixOptions>;
    keymaps?: Record<Mode, KeyTrieNode>;
    language?: LanguageConfig;
  } = {},
): Harness {
  const { text, selection } = print(annotated);
  const host = new TestHost(text, selection);
  if (options.language) host.language = options.language;
  const language = options.language ?? PLAIN_TEXT;
  const editor = new HelixEditor(host, options.options ?? {}, language.indent);
  host.onChanges = (changes) => editor.mapThroughChanges(changes);
  const handler = new KeyHandler(editor, options.keymaps ?? defaultKeymaps());
  return {
    host,
    editor,
    handler,
    async keys(keys) {
      for (const key of parseMacro(keys)) await handler.handle(key);
    },
    state: () => plain(host.state.doc.toString(), editor.selection),
    mode: () => editor.mode,
  };
}
