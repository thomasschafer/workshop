// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): the commands in helix-term's
// commands/typed.rs that make sense for a single file in Workshop.

import { TYPABLE_COMMANDS } from "./commandList";
import {
  type Context,
  gotoLineWithoutJumplist,
  pasteImpl,
  replaceSelectionsWithRegister,
} from "./commands";
import { type HelixEditor, type HelixOptions, IndentStyleKind } from "./editor";
import { Movement } from "./movement";
import { at, graphemes, nextGraphemeBoundary } from "./text";

type TypedFn = (cx: Context, args: string[]) => void | Promise<void>;

/** Splits a command line's arguments as Helix does: on whitespace, keeping quoted text together. */
export function splitArgs(line: string): string[] {
  const out: string[] = [];
  let current = "";
  let quote: string | null = null;
  let inArg = false;
  for (let i = 0; i < line.length; i++) {
    const c = line.charAt(i);
    if (quote !== null) {
      if (c === quote) quote = null;
      else current += c;
    } else if (c === "'" || c === '"' || c === "`") {
      quote = c;
      inArg = true;
    } else if (c === "\\" && i + 1 < line.length) {
      current += line.charAt(++i);
      inArg = true;
    } else if (/\s/.test(c)) {
      if (inArg) out.push(current);
      current = "";
      inArg = false;
    } else {
      current += c;
      inArg = true;
    }
  }
  if (inArg) out.push(current);
  return out;
}

const write: TypedFn = (cx) => cx.editor.host.action("write", "");

function quitUnavailable(cx: Context): void {
  cx.editor.setError("There's nothing to quit: Workshop edits one file, and keeps it saved");
}

const undoSteps =
  (redo: boolean): TypedFn =>
  (cx, args) => {
    const steps = args[0] === undefined ? 1 : Number(args[0]);
    if (!Number.isInteger(steps) || steps < 1) {
      cx.editor.setError(
        `'${args[0]}' isn't a number of steps; Workshop's history can't go back in time`,
      );
      return;
    }
    for (let i = 0; i < steps; i++) {
      if (!(redo ? cx.editor.host.redo() : cx.editor.host.undo())) {
        cx.editor.setStatus(redo ? "Already at newest change" : "Already at oldest change");
        return;
      }
    }
  };

function yankJoined(register: string): TypedFn {
  return (cx, args) => {
    const separator = args[0] ?? "\n";
    const values = cx.editor.selection.fragments(cx.editor.doc);
    cx.editor.registers.write(register === '"' ? (cx.register ?? '"') : register, [
      values.join(separator),
    ]);
    cx.editor.setStatus(
      `joined and yanked ${values.length} selection${values.length === 1 ? "" : "s"}`,
    );
  };
}

function clipboardYank(register: string): TypedFn {
  return (cx) => {
    cx.editor.registers.write(register, [cx.editor.selection.primary.fragment(cx.editor.doc)]);
    cx.editor.setStatus(`yanked primary selection to register ${register}`);
  };
}

function clipboardPaste(register: string, where: "after" | "before"): TypedFn {
  return async (cx) => {
    const values = await cx.editor.registers.read(register);
    if (values !== null) pasteImpl(cx.editor, values, where, 1);
  };
}

/** The options `:set`, `:toggle` and `:get` know, by Helix's name for them. */
const OPTIONS: Record<
  string,
  {
    get: (editor: HelixEditor) => string | number | boolean;
    set: (editor: HelixEditor, value: string) => void;
    values?: readonly string[];
  }
> = {
  "soft-wrap.enable": {
    get: (e) => e.host.softWrap(),
    set: (e, v) => e.host.setSoftWrap(parseBool(v)),
  },
  scrolloff: {
    get: (e) => e.options.scrolloff,
    set: (e, v) => setOption(e, "scrolloff", parseNumber(v)),
  },
  "auto-pairs": {
    get: (e) => e.options.autoPairs,
    set: (e, v) => setOption(e, "autoPairs", parseBool(v)),
  },
  "smart-tab.enable": {
    get: (e) => e.options.smartTab,
    set: (e, v) => setOption(e, "smartTab", parseBool(v)),
  },
  "search.smart-case": {
    get: (e) => e.options.smartCase,
    set: (e, v) => setOption(e, "smartCase", parseBool(v)),
  },
  "search.wrap-around": {
    get: (e) => e.options.wrapAround,
    set: (e, v) => setOption(e, "wrapAround", parseBool(v)),
  },
  "color-modes": {
    get: (e) => e.options.colorModes,
    set: (e, v) => setOption(e, "colorModes", parseBool(v)),
  },
  "line-number": {
    get: (e) => e.options.lineNumbers,
    set: (e, v) => {
      if (v !== "absolute" && v !== "relative")
        throw new Error("line-number is absolute or relative");
      setOption(e, "lineNumbers", v);
    },
    values: ["absolute", "relative"],
  },
  "jump-label-alphabet": {
    get: (e) => e.options.jumpLabelAlphabet,
    set: (e, v) => setOption(e, "jumpLabelAlphabet", v),
  },
};

function setOption<K extends keyof HelixOptions>(
  editor: HelixEditor,
  key: K,
  value: HelixOptions[K],
): void {
  editor.options = { ...editor.options, [key]: value };
  editor.onChange();
}

function parseBool(v: string): boolean {
  if (v === "true") return true;
  if (v === "false") return false;
  throw new Error(`'${v}' isn't true or false`);
}

function parseNumber(v: string): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw new Error(`'${v}' isn't a whole number`);
  return n;
}

function option(key: string | undefined) {
  if (key === undefined) throw new Error("Which option? For example `soft-wrap.enable`");
  const found = OPTIONS[key];
  if (found === undefined) {
    throw new Error(
      `Workshop doesn't have the option '${key}'; it has ${Object.keys(OPTIONS).join(", ")}`,
    );
  }
  return found;
}

const TYPED: Readonly<Record<string, TypedFn>> = {
  exit: async (cx) => {
    await write(cx, []);
    quitUnavailable(cx);
  },
  "exit!": async (cx) => {
    await write(cx, []);
    quitUnavailable(cx);
  },
  quit: quitUnavailable,
  "quit!": quitUnavailable,
  "quit-all": quitUnavailable,
  "quit-all!": quitUnavailable,
  cquit: quitUnavailable,
  "cquit!": quitUnavailable,
  write,
  "write!": write,
  "write-all": write,
  "write-all!": write,
  update: write,
  "write-quit": async (cx) => {
    await write(cx, []);
    quitUnavailable(cx);
  },
  "write-quit!": async (cx) => {
    await write(cx, []);
    quitUnavailable(cx);
  },
  "write-quit-all": async (cx) => {
    await write(cx, []);
    quitUnavailable(cx);
  },
  "write-quit-all!": async (cx) => {
    await write(cx, []);
    quitUnavailable(cx);
  },
  format: (cx) => cx.editor.host.action("format", ""),
  "indent-style": (cx, args) => {
    const editor = cx.editor;
    const arg = args[0];
    if (arg === undefined) {
      const style = editor.indentStyle;
      editor.setStatus(style.kind === IndentStyleKind.Tabs ? "tabs" : `${style.n} spaces`);
      return;
    }
    if (arg === "t" || arg === "tabs") {
      editor.indentOverride = { kind: IndentStyleKind.Tabs };
      return;
    }
    const n = Number(arg);
    if (!Number.isInteger(n) || n < 1 || n > 16) {
      editor.setError("indent-style is tabs, or a number of spaces from 1 to 16");
      return;
    }
    editor.indentOverride = { kind: IndentStyleKind.Spaces, n };
  },
  earlier: undoSteps(false),
  later: undoSteps(true),
  "yank-join": yankJoined('"'),
  "clipboard-yank": clipboardYank("+"),
  "clipboard-yank-join": yankJoined("+"),
  "primary-clipboard-yank": clipboardYank("*"),
  "primary-clipboard-yank-join": yankJoined("*"),
  "clipboard-paste-after": clipboardPaste("+", "after"),
  "clipboard-paste-before": clipboardPaste("+", "before"),
  "clipboard-paste-replace": (cx) => replaceSelectionsWithRegister(cx.editor, "+", 1),
  "primary-clipboard-paste-after": clipboardPaste("*", "after"),
  "primary-clipboard-paste-before": clipboardPaste("*", "before"),
  "primary-clipboard-paste-replace": (cx) => replaceSelectionsWithRegister(cx.editor, "*", 1),
  "show-clipboard-provider": (cx) => cx.editor.setStatus("Clipboard: the browser's"),
  "character-info": (cx) => {
    const editor = cx.editor;
    const doc = editor.doc;
    const start = editor.selection.primary.cursor(doc);
    const end = nextGraphemeBoundary(doc, start);
    const grapheme = doc.slice(start, end);
    if (grapheme === "") {
      editor.setStatus("EOF");
      return;
    }
    if (grapheme === "\n") {
      editor.setStatus('"\\n" (U+000A) Dec 10 Hex 0a');
      return;
    }
    const codes = [...grapheme].map(
      (ch) => `U+${(ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`,
    );
    const bytes = [...new TextEncoder().encode(grapheme)].map((b) =>
      b.toString(16).padStart(2, "0"),
    );
    const one = [...grapheme].length === 1 ? ` Dec ${grapheme.codePointAt(0)}` : "";
    editor.setStatus(`"${grapheme}" (${codes.join(" ")})${one} Hex ${bytes.join(" ")}`);
  },
  reload: (cx) => cx.editor.host.action("reload", ""),
  "reload-all": (cx) => cx.editor.host.action("reload", ""),
  goto: (cx, args) => {
    const line = Number(args[0]);
    if (!Number.isInteger(line) || line < 1) {
      cx.editor.setError("goto needs a line number");
      return;
    }
    cx.editor.pushJump();
    gotoLineWithoutJumplist(cx.editor, line, Movement.Move);
  },
  "set-option": (cx, args) => {
    const [key, ...rest] = args;
    option(key).set(cx.editor, rest.join(" "));
  },
  "toggle-option": (cx, args) => {
    const [key, ...values] = args;
    const opt = option(key);
    const current = opt.get(cx.editor);
    if (typeof current === "boolean") {
      if (values.length > 0)
        throw new Error(`Bad arguments. For boolean configurations use: \`:toggle ${key}\``);
      opt.set(cx.editor, String(!current));
    } else {
      const cycle = values.length > 0 ? values : (opt.values ?? []);
      if (cycle.length === 0)
        throw new Error(
          `Bad arguments. For string configurations use: \`:toggle ${key} val1 val2 ...\``,
        );
      const index = cycle.indexOf(String(current));
      opt.set(cx.editor, at(cycle, (index + 1) % cycle.length));
    }
    cx.editor.setStatus(`'${key}' is now set to ${String(opt.get(cx.editor))}`);
  },
  "get-option": (cx, args) => {
    cx.editor.setStatus(String(option(args[0]).get(cx.editor)));
  },
  sort: (cx, args) => {
    const editor = cx.editor;
    const doc = editor.doc;
    const selection = editor.selection;
    if (selection.length === 1) {
      editor.setError("Sorting requires multiple selections. Hint: split selection first");
      return;
    }
    const insensitive = args.includes("--insensitive") || args.includes("-i");
    const reverse = args.includes("--reverse") || args.includes("-r");
    const key = (s: string) => (insensitive ? s.toLowerCase() : s);
    const fragments = selection.fragments(doc).sort((a, b) => {
      const [x, y] = reverse ? [key(b), key(a)] : [key(a), key(b)];
      return x < y ? -1 : x > y ? 1 : 0;
    });
    editor.apply(
      selection.ranges.map((r, i) => ({ from: r.from, to: r.to, insert: at(fragments, i) })),
    );
  },
  reflow: (cx, args) => {
    const width = args[0] === undefined ? 79 : Number(args[0]);
    if (!Number.isInteger(width) || width < 1) {
      cx.editor.setError("reflow needs a positive width");
      return;
    }
    const editor = cx.editor;
    const doc = editor.doc;
    editor.apply(
      editor.selection.ranges.map((r) => ({
        from: r.from,
        to: r.to,
        insert: reflow(r.fragment(doc), width),
      })),
    );
  },
  "clear-register": (cx, args) => {
    if (args.length === 0) {
      cx.editor.registers.clearAll();
      cx.editor.setStatus("All registers cleared");
      return;
    }
    const name = at(args, 0);
    if ([...name].length !== 1) {
      cx.editor.setError(`Invalid register ${name}`);
      return;
    }
    if (cx.editor.registers.clear(name)) cx.editor.setStatus(`Register ${name} cleared`);
    else cx.editor.setError(`Register ${name} not found`);
  },
  "set-register": (cx, args) => {
    const [name, ...rest] = args;
    if (name === undefined || [...name].length !== 1) {
      cx.editor.setError("set-register needs a register and a value");
      return;
    }
    cx.editor.registers.write(name, [rest.join(" ")]);
  },
  redraw: () => {},
  echo: (cx, args) => cx.editor.setStatus(args.join(" ")),
  noop: () => {},
  "yank-diagnostic": (cx, args) => {
    const editor = cx.editor;
    const register = args[0] ?? "+";
    const primary = editor.selection.primary;
    const messages = editor.host
      .diagnostics()
      .filter((d) => d.from < primary.to && d.to >= primary.from)
      .map((d) => d.message);
    if (messages.length === 0) {
      editor.setError("No diagnostics under primary selection");
      return;
    }
    editor.registers.write(register, [messages.join("\n")]);
    editor.setStatus(
      `Yanked ${messages.length} diagnostic${messages.length === 1 ? "" : "s"} to register ${register}`,
    );
  },
};

/** Typed commands Workshop doesn't have, and why. */
const UNSUPPORTED_TYPED: Readonly<Record<string, string>> = {
  ...Object.fromEntries(
    [
      "open",
      "open-no-completions",
      "open-recent",
      "buffer-close",
      "buffer-close!",
      "buffer-close-others",
      "buffer-close-others!",
      "buffer-close-all",
      "buffer-close-all!",
      "buffer-next",
      "buffer-previous",
      "buffer-move-left",
      "buffer-move-right",
      "write-buffer-close",
      "write-buffer-close!",
      "new",
      "vsplit",
      "vsplit-new",
      "hsplit",
      "hsplit-new",
      "move",
      "move!",
      "read",
      "change-current-directory",
      "show-directory-stack",
      "push-directory",
      "pop-directory",
      "show-directory",
      "set-language",
      "encoding",
    ].map((n) => [
      n,
      "works with files and buffers, and Workshop edits one file it chooses itself",
    ]),
  ),
  ...Object.fromEntries(
    ["insert-output", "append-output", "pipe", "pipe-to", "run-shell-command"].map((n) => [
      n,
      "runs shell commands, which Workshop's editor never does",
    ]),
  ),
  ...Object.fromEntries(
    [
      "tree-sitter-scopes",
      "tree-sitter-highlight-name",
      "tree-sitter-layers",
      "tree-sitter-subtree",
    ].map((n) => [n, "needs a syntax tree, which Workshop's editor doesn't have"]),
  ),
  ...Object.fromEntries(
    ["debug-start", "debug-remote", "debug-eval"].map((n) => [
      n,
      "needs a debugger, which Workshop doesn't have",
    ]),
  ),
  ...Object.fromEntries(
    ["lsp-workspace-command", "lsp-restart", "lsp-stop"].map((n) => [
      n,
      "Workshop runs the language server itself",
    ]),
  ),
  ...Object.fromEntries(
    ["theme", "config-reload", "config-open", "config-open-workspace", "log-open", "tutor"].map(
      (n) => [
        n,
        "is part of Helix itself; Workshop's settings are in Settings and its config file",
      ],
    ),
  ),
  "reset-diff-change": "needs version control changes, which Workshop doesn't show",
  "workspace-trust": "is part of Helix itself",
  "workspace-untrust": "is part of Helix itself",
  "workspace-exclude": "is part of Helix itself",
};

const BY_NAME = new Map(
  TYPABLE_COMMANDS.flatMap((c) => [c.name, ...c.aliases].map((n) => [n, c.name] as const)),
);

/** Runs a command line, as typed after `:`, such as `w` or `sort -r`. A number goes to that line. */
export async function runCommandLine(cx: Context, line: string): Promise<void> {
  const trimmed = line.trim();
  if (trimmed === "") return;
  const [rawName = "", ...args] = splitArgs(trimmed);
  if (/^\d+$/.test(rawName)) {
    cx.editor.pushJump();
    gotoLineWithoutJumplist(cx.editor, Number(rawName), Movement.Move);
    return;
  }
  await runTyped(cx, rawName, args);
}

export async function runTyped(cx: Context, rawName: string, args: string[]): Promise<void> {
  const name = BY_NAME.get(rawName);
  if (name === undefined) {
    cx.editor.setError(`no such command: '${rawName}'`);
    return;
  }
  const unsupported = UNSUPPORTED_TYPED[name];
  if (unsupported !== undefined) {
    cx.editor.setError(`:${name} isn't available in Workshop: it ${unsupported}`);
    return;
  }
  const f = TYPED[name];
  if (f === undefined) throw new Error(`the typable command :${name} has no implementation`);
  try {
    await f(cx, args);
  } catch (e) {
    cx.editor.setError((e as Error).message);
  }
}

/** Whether Workshop has the typable command `name` (or alias). */
export function typedCommandSupported(name: string): boolean {
  const canonical = BY_NAME.get(name);
  return canonical !== undefined && canonical in TYPED;
}

/** Why Workshop doesn't have a typable command, if it doesn't. */
export function typedCommandUnsupportedReason(name: string): string | null {
  const canonical = BY_NAME.get(name);
  return canonical === undefined ? null : (UNSUPPORTED_TYPED[canonical] ?? null);
}

/** Wraps text at `width` columns, keeping each paragraph's indentation and comment leader. */
function reflow(text: string, width: number): string {
  const trailingNewline = text.endsWith("\n");
  const paragraphs = (trailingNewline ? text.slice(0, -1) : text).split(/\n[ \t]*\n/);
  const out = paragraphs.map((para) => {
    const lines = para.split("\n");
    const prefix = /^[ \t]*(?:(?:\/\/+|#+|--+|;+|\*)[ \t]?)?/.exec(at(lines, 0))?.[0] ?? "";
    const words = lines
      .map((l) => (l.startsWith(prefix) ? l.slice(prefix.length) : l.trimStart()))
      .join(" ")
      .split(/\s+/)
      .filter((w) => w !== "");
    const wrapped: string[] = [];
    let current = "";
    for (const word of words) {
      const candidate = current === "" ? word : `${current} ${word}`;
      if (graphemes(prefix + candidate).length > width && current !== "") {
        wrapped.push(prefix + current);
        current = word;
      } else {
        current = candidate;
      }
    }
    if (current !== "" || wrapped.length === 0) wrapped.push(prefix + current);
    return wrapped.join("\n");
  });
  return out.join("\n\n") + (trailingNewline ? "\n" : "");
}
