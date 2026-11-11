// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): how helix-term's ui/editor.rs and
// ui/prompt.rs handle keys, including counts, `.` and macros.

import { TYPABLE_COMMANDS } from "./commandList";
import {
  COMMANDS,
  type Context,
  FALLBACKS,
  insertChar,
  type OnKeyKind,
  UNSUPPORTED,
} from "./commands";
import type { HelixEditor } from "./editor";
import {
  commandName,
  infobox,
  type KeymapResult,
  Keymaps,
  type KeyTrieNode,
  type MappableCommand,
  type Mode,
} from "./keymap";
import { KEY, type Key, keyCharWithModifiers, parseKey, unparseKey } from "./keys";
import { type PickerItem, pickerMatches } from "./picker";
import { at } from "./text";
import { TextObject, textobjectWord } from "./textobject";
import { runCommandLine, runTyped, typedCommandSupported } from "./typed";

type OnKeyCallback = (cx: Context, key: Key) => void | Promise<void>;

const NULL_KEY = "null" as Key;

/** Turns keys into commands on the editor, as Helix's editor view does. */
export class KeyHandler {
  readonly keymaps: Keymaps;
  private onNextKey: { callback: OnKeyCallback; kind: OnKeyKind } | null = null;
  /** Keys pressed for a command still waiting for more, shown beside the mode. */
  pseudoPending: Key[] = [];
  /** How insert mode was last entered, and what was typed, which `.` repeats. */
  private lastInsert: { command: MappableCommand; keys: Key[] } = {
    command: { kind: "static", name: "normal_mode" },
    keys: [],
  };
  private queue: Promise<void> = Promise.resolve();
  /** Where the cursor is in the prompt's input, if one is open. */
  promptCursor = 0;
  private promptHistoryIndex: number | null = null;
  private promptNextChar: ((ch: string) => void) | null = null;
  /** What was typed before completing, which completions cycle through matches of. */
  private promptCompletionStem: string | null = null;

  constructor(
    readonly editor: HelixEditor,
    keymaps: Record<Mode, KeyTrieNode>,
    /** Called once a key has been handled, so the view can catch up. */
    private readonly afterKey: () => void = () => {},
  ) {
    this.keymaps = new Keymaps(keymaps);
  }

  /** Handles a key after any still being handled. */
  handle(key: Key): Promise<void> {
    const run = this.queue.then(() => this.process(key));
    this.queue = run.catch(() => {});
    return run;
  }

  /** Types text, as if each character's key were pressed. */
  type(text: string): Promise<void> {
    let run = Promise.resolve();
    for (const ch of text) {
      const key =
        ch === "\n"
          ? KEY.ret
          : ch === "\t"
            ? KEY.tab
            : parseKey(ch === "-" ? "minus" : ch === " " ? "space" : ch);
      run = this.handle(key);
    }
    return run;
  }

  /** Whether `key` would do something now, rather than being typed or ignored. */
  isBound(key: Key): boolean {
    if (this.editor.prompt || this.onNextKey || this.keymaps.pending().length > 0) return true;
    return this.keymaps.containsKey(this.editor.mode, key) || this.keymaps.sticky !== null;
  }

  /** What's pending, for showing beside the mode: the count, register and keys. */
  pendingDisplay(): string {
    const parts: string[] = [];
    if (this.editor.selectedRegister) parts.push(`"${this.editor.selectedRegister}`);
    if (this.editor.count !== null) parts.push(String(this.editor.count));
    parts.push(this.pseudoPending.join(""));
    return parts.join("");
  }

  private async process(key: Key): Promise<void> {
    const editor = this.editor;
    // Keys a macro replays aren't recorded again.
    if (editor.macroRecording && editor.macroReplaying.length === 0)
      editor.macroRecording.keys.push(key);
    const deferred: (() => Promise<void>)[] = [];
    try {
      if (editor.picker) {
        await this.pickerKey(key, deferred);
        return;
      }
      if (editor.prompt) {
        await this.promptKey(key);
        return;
      }
      editor.status = null;
      const cx = this.context(deferred);
      const mode = editor.mode;
      if (!(await this.runOnNextKey("pseudoPending", cx, key))) {
        if (mode === "insert") {
          await this.insertMode(cx, key);
          this.lastInsert.keys.push(key);
        } else {
          await this.commandMode(mode, cx, key);
        }
      }
      this.onNextKey = cx.pendingOnNextKey;
      if (this.onNextKey?.kind === "pseudoPending") this.pseudoPending.push(key);
      else this.pseudoPending = [...this.keymaps.pending()];
      if (editor.mode !== "insert") editor.commitUndoCheckpoint();
    } finally {
      this.afterKey();
      editor.onChange();
    }
    for (const f of deferred) await f();
  }

  private context(deferred: (() => Promise<void>)[]): Context & {
    pendingOnNextKey: { callback: OnKeyCallback; kind: OnKeyKind } | null;
  } {
    const cx = {
      editor: this.editor,
      count: null as number | null,
      register: null as string | null,
      pendingOnNextKey: null as { callback: OnKeyCallback; kind: OnKeyKind } | null,
      onNextKey: (callback: OnKeyCallback, kind: OnKeyKind = "pseudoPending") => {
        cx.pendingOnNextKey = { callback, kind };
      },
      feedKeys: async (keys: readonly Key[]) => {
        for (const k of keys) await this.process(k);
      },
      defer: (f: () => Promise<void>) => {
        deferred.push(f);
      },
      runCommandLine: (line: string) => runCommandLine(cx, line),
      runCommand: (command: MappableCommand) => this.execute(cx, command),
      openPicker: (title: string, items: readonly PickerItem[]) =>
        this.openPicker(cx, title, items),
      bindings: () => this.bindings(this.editor.mode),
    };
    return cx;
  }

  private async runOnNextKey(kind: OnKeyKind, cx: Context, key: Key): Promise<boolean> {
    const pending = this.onNextKey;
    if (pending === null) return false;
    if (pending.kind !== kind) return false;
    this.onNextKey = null;
    await pending.callback(cx, key);
    return true;
  }

  private async commandMode(mode: Mode, cx: Context, key: Key): Promise<void> {
    const editor = this.editor;
    const digit = /^[0-9]$/.test(key) ? Number(key) : null;
    if (digit !== null && editor.count !== null) {
      // A count that's started always continues.
      const next = editor.count * 10 + digit;
      if (next <= 100_000_000) editor.count = next;
      return;
    }
    if (digit !== null && digit !== 0 && !this.keymaps.containsKey(mode, key)) {
      editor.count = digit;
      return;
    }
    if (key === "." && this.keymaps.pending().length === 0) {
      const times = editor.count ?? 1;
      editor.count = null;
      for (let i = 0; i < times; i++) {
        // Run what entered insert mode, then what was typed.
        await this.execute(cx, this.lastInsert.command);
        for (const k of [...this.lastInsert.keys]) await this.insertMode(cx, k);
      }
      return;
    }
    cx.count = editor.count;
    cx.register = editor.selectedRegister;
    editor.selectedRegister = null;
    const result = await this.handleKeymapEvent(mode, cx, key);
    if (result?.kind === "notFound") await this.runOnNextKey("fallback", cx, key);
    if (this.keymaps.pending().length === 0) {
      editor.count = null;
    } else {
      editor.selectedRegister = cx.register;
    }
  }

  private async insertMode(cx: Context, key: Key): Promise<void> {
    const result = await this.handleKeymapEvent("insert", cx, key);
    if (result === null) return;
    if (result.kind === "notFound") {
      if (!(await this.runOnNextKey("fallback", cx, key))) {
        const ch = keyCharWithModifiers(key);
        if (ch !== null) insertChar(cx, ch);
      }
    } else if (result.kind === "cancelled") {
      for (const k of result.keys) {
        const ch = keyCharWithModifiers(k);
        if (ch !== null) {
          insertChar(cx, ch);
        } else {
          const found = this.keymaps.get("insert", k);
          if (found.kind === "matched") await this.execute(cx, found.command);
        }
      }
    }
  }

  /** Runs what `key` is bound to, or returns why nothing ran. */
  private async handleKeymapEvent(mode: Mode, cx: Context, key: Key): Promise<KeymapResult | null> {
    const editor = this.editor;
    let lastMode = mode;
    const result = this.keymaps.get(mode, key);
    editor.autoinfo = this.keymaps.sticky ? infobox(this.keymaps.sticky) : null;
    const run = async (command: MappableCommand) => {
      await this.execute(cx, command);
      const current = editor.mode;
      // Remember what entered insert mode, for `.`.
      if (current !== lastMode && current === "insert") this.lastInsert = { command, keys: [] };
      lastMode = current;
    };
    switch (result.kind) {
      case "matched":
        await run(result.command);
        return null;
      case "sequence":
        for (const command of result.commands) await run(command);
        return null;
      case "pending":
        editor.autoinfo = infobox(result.node);
        return null;
      case "fallback": {
        const f = FALLBACKS[result.command];
        if (f === undefined) throw new Error(`no fallback command named ${result.command}`);
        f(cx, result.ch);
        return null;
      }
      case "notFound":
      case "cancelled":
        return result;
    }
  }

  /** Runs a command from a keymap. */
  async execute(cx: Context, command: MappableCommand): Promise<void> {
    const editor = this.editor;
    switch (command.kind) {
      case "static": {
        const unsupported = UNSUPPORTED[command.name];
        if (unsupported !== undefined) {
          editor.setError(`${command.name} isn't available in Workshop: it ${unsupported}`);
          return;
        }
        const f = COMMANDS[command.name];
        if (f === undefined) throw new Error(`the command ${command.name} has no implementation`);
        await f(cx);
        return;
      }
      case "typable":
        if (/^\d+$/.test(command.name)) {
          await runCommandLine(cx, command.name);
        } else {
          await runTyped(cx, command.name, command.args === "" ? [] : command.args.split(/\s+/));
        }
        return;
      case "macro": {
        // Protect against recursive macros.
        if (editor.macroReplaying.includes("@")) {
          editor.setError(
            "Cannot execute macro because the [@] register is already playing a macro",
          );
          return;
        }
        editor.macroReplaying.push("@");
        const keys = command.keys;
        // The keys run once this key is done, as Helix runs them.
        cx.defer(async () => {
          try {
            await cx.feedKeys(keys);
          } finally {
            editor.macroReplaying.pop();
          }
        });
        return;
      }
    }
  }

  /** The keys bound to each command in `mode`, by name, written as key sequences. */
  bindings(mode: Mode): Map<string, string[]> {
    const out = new Map<string, string[]>();
    const walk = (node: KeyTrieNode, prefix: string) => {
      for (const [key, trie] of node.map) {
        const keys = prefix + ([...key].length === 1 ? key : `<${key}>`);
        if (trie.kind === "node") {
          walk(trie.node, keys);
        } else if (trie.kind === "command") {
          const name = commandName(trie.command);
          out.set(name, [...(out.get(name) ?? []), keys]);
        }
      }
    };
    walk(this.keymaps.map[mode], "");
    return out;
  }

  // ---- Pickers ----

  /** Opens a picker, whose items run with the count and register given before it. */
  openPicker(cx: Context, title: string, items: readonly PickerItem[]): void {
    this.pickerContext = { count: cx.count, register: cx.register };
    this.editor.picker = { title, items, query: "", selected: 0 };
    this.editor.onChange();
  }

  private pickerContext: { count: number | null; register: string | null } = {
    count: null,
    register: null,
  };

  private async pickerKey(key: Key, deferred: (() => Promise<void>)[]): Promise<void> {
    const editor = this.editor;
    const picker = editor.picker;
    if (picker === null) return;
    const matches = pickerMatches(picker);
    const move = (by: number) => {
      if (matches.length === 0) return;
      picker.selected = (picker.selected + by + matches.length) % matches.length;
    };
    switch (key as string) {
      case "esc":
      case "C-c":
        editor.picker = null;
        return;
      case "ret": {
        const item = matches[picker.selected];
        editor.picker = null;
        if (item === undefined) return;
        const cx = this.context(deferred);
        cx.count = this.pickerContext.count;
        cx.register = this.pickerContext.register;
        await item.run(cx);
        this.onNextKey = cx.pendingOnNextKey;
        return;
      }
      case "up":
      case "C-p":
      case "S-tab":
        move(-1);
        return;
      case "down":
      case "C-n":
      case "tab":
        move(1);
        return;
      case "pageup":
      case "C-u":
        move(-10);
        return;
      case "pagedown":
      case "C-d":
        move(10);
        return;
      case "home":
        picker.selected = 0;
        return;
      case "end":
        picker.selected = Math.max(0, matches.length - 1);
        return;
      case "backspace":
      case "C-h":
        picker.query = picker.query.slice(0, -1);
        picker.selected = 0;
        return;
      case "C-w":
      case "A-backspace":
        picker.query = picker.query.slice(
          0,
          wordBoundaryBackward(picker.query, picker.query.length),
        );
        picker.selected = 0;
        return;
    }
    const parsed = unparseKey(key);
    if ([...parsed.code].length === 1 && !parsed.ctrl && !parsed.meta) {
      picker.query += parsed.code;
      picker.selected = 0;
    }
  }

  // ---- The prompt ----

  private async promptKey(key: Key): Promise<void> {
    const editor = this.editor;
    const prompt = editor.prompt;
    if (prompt === null) return;
    const update = () => prompt.onEvent(editor, prompt.input, "update");
    const setInput = (input: string, cursor: number) => {
      prompt.input = input;
      this.promptCursor = cursor;
    };
    if (this.promptNextChar) {
      const handler = this.promptNextChar;
      this.promptNextChar = null;
      editor.autoinfo = null;
      const ch = keyCharWithModifiers(key);
      if (ch !== null) handler(ch);
      update();
      return;
    }
    const { input } = prompt;
    const cursor = Math.min(this.promptCursor, input.length);
    if (key !== KEY.tab && key !== ("S-tab" as Key)) this.promptCompletionStem = null;
    const parsed = unparseKey(key);
    const close = () => {
      editor.prompt = null;
      this.promptCursor = 0;
      this.promptHistoryIndex = null;
      this.promptCompletionStem = null;
    };
    switch (key as string) {
      case "C-c":
      case "esc":
        close();
        await prompt.onEvent(editor, input, "abort");
        return;
      case "A-b":
      case "C-left":
        this.promptCursor = wordBoundaryBackward(input, cursor);
        return;
      case "A-f":
      case "C-right":
        this.promptCursor = wordBoundaryForward(input, cursor);
        return;
      case "C-b":
      case "left":
        this.promptCursor = Math.max(0, cursor - 1);
        return;
      case "C-f":
      case "right":
        this.promptCursor = Math.min(input.length, cursor + 1);
        return;
      case "C-e":
      case "end":
        this.promptCursor = input.length;
        return;
      case "C-a":
      case "home":
        this.promptCursor = 0;
        return;
      case "C-w":
      case "A-backspace":
      case "C-backspace": {
        const start = wordBoundaryBackward(input, cursor);
        setInput(input.slice(0, start) + input.slice(cursor), start);
        update();
        return;
      }
      case "A-d":
      case "A-del":
      case "C-del": {
        const end = wordBoundaryForward(input, cursor);
        setInput(input.slice(0, cursor) + input.slice(end), cursor);
        update();
        return;
      }
      case "C-k":
        setInput(input.slice(0, cursor), cursor);
        update();
        return;
      case "C-u":
        setInput(input.slice(cursor), 0);
        update();
        return;
      case "C-h":
      case "backspace":
      case "S-backspace":
        if (cursor > 0) setInput(input.slice(0, cursor - 1) + input.slice(cursor), cursor - 1);
        update();
        return;
      case "C-d":
      case "del":
        setInput(input.slice(0, cursor) + input.slice(cursor + 1), cursor);
        update();
        return;
      case "C-s": {
        const doc = editor.doc;
        const range = textobjectWord(doc, editor.selection.primary, TextObject.Inside, false);
        const word = range.fragment(doc);
        if (word !== "") {
          setInput(input.slice(0, cursor) + word + input.slice(cursor), cursor + word.length);
          update();
        }
        return;
      }
      case "ret": {
        const history = prompt.historyRegister
          ? editor.registers.readSync(prompt.historyRegister)
          : null;
        const last = history?.[0] ?? "";
        let value = input;
        if (input === "") {
          value = last;
        } else if (last !== input && prompt.historyRegister) {
          try {
            editor.registers.push(prompt.historyRegister, input);
          } catch (e) {
            editor.setError((e as Error).message);
          }
        }
        close();
        await prompt.onEvent(editor, value, "validate");
        return;
      }
      case "C-p":
      case "up":
      case "C-n":
      case "down": {
        if (!prompt.historyRegister) return;
        const history = editor.registers.readSync(prompt.historyRegister) ?? [];
        if (history.length === 0) return;
        const back = key === "C-p" || key === "up";
        const current = this.promptHistoryIndex;
        let next: number;
        if (back) next = current === null ? 0 : Math.min(history.length - 1, current + 1);
        else next = current === null ? history.length - 1 : Math.max(0, current - 1);
        this.promptHistoryIndex = next;
        const entry = at(history, next);
        setInput(entry, entry.length);
        update();
        return;
      }
      case "tab":
      case "S-tab":
        this.completePrompt(key === "tab");
        update();
        return;
      case "C-r":
        editor.autoinfo = { title: "Insert register", body: editor.registers.preview() };
        this.promptNextChar = (ch) => {
          const value = editor.registers.first(ch) ?? "";
          const p = editor.prompt;
          if (p === null) return;
          const at = Math.min(this.promptCursor, p.input.length);
          p.input = p.input.slice(0, at) + value + p.input.slice(at);
          this.promptCursor = at + value.length;
        };
        return;
    }
    const ch = parsed.code.length >= 1 && [...parsed.code].length === 1 ? parsed.code : null;
    if (ch !== null && !parsed.ctrl && !parsed.meta) {
      setInput(input.slice(0, cursor) + ch + input.slice(cursor), cursor + ch.length);
      update();
    }
  }

  /** Completes a command name in the `:` prompt. */
  private completePrompt(forward: boolean): void {
    const prompt = this.editor.prompt;
    if (prompt === null || prompt.label !== ":") return;
    const typed = prompt.input.trimStart();
    if (/\s/.test(typed)) return;
    const stem = this.promptCompletionStem ?? typed;
    this.promptCompletionStem = stem;
    const completions = TYPABLE_COMMANDS.flatMap((c) => [c.name, ...c.aliases])
      .filter((name) => name.startsWith(stem) && typedCommandSupported(name))
      .sort();
    if (completions.length === 0) return;
    const index = completions.indexOf(prompt.input);
    const next =
      index === -1
        ? forward
          ? 0
          : completions.length - 1
        : (index + (forward ? 1 : completions.length - 1)) % completions.length;
    prompt.input = at(completions, next);
    this.promptCursor = prompt.input.length;
  }

  /** Pastes text into the prompt, if one is open, returning whether it was. */
  pasteIntoPrompt(text: string): boolean {
    const prompt = this.editor.prompt;
    if (prompt === null) return false;
    const at = Math.min(this.promptCursor, prompt.input.length);
    prompt.input = prompt.input.slice(0, at) + text + prompt.input.slice(at);
    this.promptCursor = at + text.length;
    prompt.onEvent(this.editor, prompt.input, "update");
    this.editor.onChange();
    return true;
  }

  /** Dismisses anything waiting for a key, as a click does in Helix. */
  dismissPending(): void {
    this.onNextKey = null;
    this.keymaps.get(this.editor.mode, NULL_KEY);
    this.pseudoPending = [];
    this.editor.autoinfo = null;
    this.editor.jumpLabels = [];
    this.editor.onChange();
  }

  describe(command: MappableCommand): string {
    return commandName(command);
  }
}

function wordBoundaryBackward(s: string, pos: number): number {
  let i = pos;
  while (i > 0 && /\s/.test(s.charAt(i - 1))) i--;
  while (i > 0 && !/\s/.test(s.charAt(i - 1))) i--;
  return i;
}

function wordBoundaryForward(s: string, pos: number): number {
  let i = pos;
  while (i < s.length && /\s/.test(s.charAt(i))) i++;
  while (i < s.length && !/\s/.test(s.charAt(i))) i++;
  return i;
}
