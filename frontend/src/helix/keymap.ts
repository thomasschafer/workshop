// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-term's keymap.rs and
// keymap/default.rs.

import { STATIC_COMMANDS, TYPABLE_COMMANDS } from "./commandList";
import { KEY, type Key, type KeyError, keyChar, parseKey, parseMacro } from "./keys";

export type Mode = "normal" | "select" | "insert";

export type MappableCommand =
  | { readonly kind: "static"; readonly name: string }
  | { readonly kind: "typable"; readonly name: string; readonly args: string }
  | { readonly kind: "macro"; readonly name: string; readonly keys: readonly Key[] };

export type KeyTrie =
  | { readonly kind: "command"; readonly command: MappableCommand }
  | { readonly kind: "sequence"; readonly commands: readonly MappableCommand[] }
  | { readonly kind: "node"; readonly node: KeyTrieNode };

export interface KeyTrieNode {
  readonly name: string;
  /** In the order the keys were bound, which is the order the help lists them in. */
  readonly map: Map<Key, KeyTrie>;
  readonly sticky: boolean;
  /** Run with the key pressed when it isn't bound in this node, if it's a character. */
  readonly fallback: string | null;
}

export class CommandError extends Error {}

const TYPABLE_BY_NAME = new Map(
  TYPABLE_COMMANDS.flatMap((c) => [c.name, ...c.aliases].map((n) => [n, c] as const)),
);

/** Fallback commands, which take the character pressed. */
export const FALLBACK_COMMANDS: Readonly<Record<string, string>> = {
  select_textobject_inside_surrounding_pair: "Select inside any character pair",
  select_textobject_around_surrounding_pair: "Select around any character pair",
  select_textobject_inside_prev_pair: "Select inside previous character pair",
  select_textobject_inside_next_pair: "Select inside next character pair",
};

/** Reads a command as a keymap names it: `name`, `:typable args`, or `@keys` for a macro. */
export function parseCommand(s: string): MappableCommand {
  if (s.startsWith(":")) {
    const line = s.slice(1).trim();
    const space = line.search(/\s/);
    const name = space === -1 ? line : line.slice(0, space);
    const args = space === -1 ? "" : line.slice(space).trim();
    if (name === "") throw new CommandError("Expected typable command name");
    const typable = TYPABLE_BY_NAME.get(name);
    if (typable === undefined && !/^\d+$/.test(name)) {
      throw new CommandError(`No typable command named ':${name}'`);
    }
    return { kind: "typable", name: typable?.name ?? name, args };
  }
  if (s.startsWith("@")) {
    try {
      return { kind: "macro", name: s, keys: parseMacro(s.slice(1)) };
    } catch (e) {
      throw new CommandError(`Invalid macro '${s}': ${(e as Error).message}`);
    }
  }
  if (!(s in STATIC_COMMANDS)) throw new CommandError(`No command named '${s}'`);
  return { kind: "static", name: s };
}

export function commandDoc(command: MappableCommand): string {
  switch (command.kind) {
    case "static":
      return STATIC_COMMANDS[command.name] ?? command.name;
    case "typable":
      return `:${command.name}${command.args ? ` ${command.args}` : ""}`;
    case "macro":
      return command.name;
  }
}

export function commandName(command: MappableCommand): string {
  return command.kind === "typable" ? `:${command.name}` : command.name;
}

// ---- Building tries ----

type Spec = string | readonly string[] | NodeSpec;

interface NodeSpec {
  readonly label: string;
  readonly sticky?: boolean;
  readonly fallback?: string;
  readonly keys: readonly (readonly [string | readonly string[], Spec])[];
}

function node(
  label: string,
  keys: NodeSpec["keys"],
  options: { sticky?: boolean; fallback?: string } = {},
): NodeSpec {
  return { label, keys, ...options };
}

function build(spec: Spec): KeyTrie {
  if (typeof spec === "string") return { kind: "command", command: parseCommand(spec) };
  if (Array.isArray(spec)) {
    return { kind: "sequence", commands: (spec as readonly string[]).map(parseCommand) };
  }
  const n = spec as NodeSpec;
  const map = new Map<Key, KeyTrie>();
  for (const [keys, value] of n.keys) {
    for (const key of typeof keys === "string" ? [keys] : keys) {
      const parsed = parseKey(key);
      if (map.has(parsed)) throw new Error(`duplicate key ${key} in the default keymap`);
      map.set(parsed, build(value));
    }
  }
  return {
    kind: "node",
    node: { name: n.label, map, sticky: n.sticky ?? false, fallback: n.fallback ?? null },
  };
}

function cloneTrie(trie: KeyTrie): KeyTrie {
  if (trie.kind !== "node") return trie;
  return {
    kind: "node",
    node: {
      ...trie.node,
      map: new Map([...trie.node.map].map(([k, v]) => [k, cloneTrie(v)])),
    },
  };
}

/** Merges `other` into `into`: nodes merge with nodes, and anything else replaces what's there. */
function mergeNodes(into: KeyTrieNode, other: KeyTrieNode): void {
  for (const [key, trie] of other.map) {
    const existing = into.map.get(key);
    if (existing?.kind === "node" && trie.kind === "node") {
      mergeNodes(existing.node, trie.node);
    } else {
      into.map.set(key, trie);
    }
  }
}

// ---- The default keymap ----

const VIEW_KEYS: NodeSpec["keys"] = [
  [["z", "c"], "align_view_center"],
  ["t", "align_view_top"],
  ["b", "align_view_bottom"],
  ["m", "align_view_middle"],
  [["k", "up"], "scroll_up"],
  [["j", "down"], "scroll_down"],
  [["C-b", "pageup"], "page_up"],
  [["C-f", "pagedown"], "page_down"],
  [["C-u", "backspace"], "page_cursor_half_up"],
  [["C-d", "space"], "page_cursor_half_down"],
  ["/", "search"],
  ["?", "rsearch"],
  ["n", "search_next"],
  ["N", "search_prev"],
];

const WINDOW_KEYS: NodeSpec["keys"] = [
  [["C-w", "w"], "rotate_view"],
  [["C-s", "s"], "hsplit"],
  [["C-v", "v"], "vsplit"],
  [["C-t", "t"], "transpose_view"],
  ["f", "goto_file_hsplit"],
  ["F", "goto_file_vsplit"],
  [["C-q", "q"], "wclose"],
  [["C-o", "o"], "wonly"],
  [["C-h", "h", "left"], "jump_view_left"],
  [["C-j", "j", "down"], "jump_view_down"],
  [["C-k", "k", "up"], "jump_view_up"],
  [["C-l", "l", "right"], "jump_view_right"],
  ["L", "swap_view_right"],
  ["K", "swap_view_up"],
  ["H", "swap_view_left"],
  ["J", "swap_view_down"],
  [
    "n",
    node("New split scratch buffer", [
      [["C-s", "s"], "hsplit_new"],
      [["C-v", "v"], "vsplit_new"],
    ]),
  ],
];

const NORMAL = node("Normal mode", [
  [["h", "left"], "move_char_left"],
  [["j", "down"], "move_visual_line_down"],
  [["k", "up"], "move_visual_line_up"],
  [["l", "right"], "move_char_right"],
  ["t", "find_till_char"],
  ["f", "find_next_char"],
  ["T", "till_prev_char"],
  ["F", "find_prev_char"],
  ["r", "replace"],
  ["R", "replace_with_yanked"],
  ["A-.", "repeat_last_motion"],
  ["~", "switch_case"],
  ["`", "switch_to_lowercase"],
  ["A-`", "switch_to_uppercase"],
  ["home", "goto_line_start"],
  ["end", "goto_line_end"],
  ["w", "move_next_word_start"],
  ["b", "move_prev_word_start"],
  ["e", "move_next_word_end"],
  ["W", "move_next_long_word_start"],
  ["B", "move_prev_long_word_start"],
  ["E", "move_next_long_word_end"],
  ["v", "select_mode"],
  ["G", "goto_line"],
  [
    "g",
    node("Goto", [
      ["g", "goto_file_start"],
      ["|", "goto_column"],
      ["e", "goto_last_line"],
      ["f", "goto_file"],
      ["h", "goto_line_start"],
      ["l", "goto_line_end"],
      ["s", "goto_first_nonwhitespace"],
      ["d", "goto_definition"],
      ["D", "goto_declaration"],
      ["y", "goto_type_definition"],
      ["r", "goto_reference"],
      ["i", "goto_implementation"],
      ["t", "goto_window_top"],
      ["c", "goto_window_center"],
      ["b", "goto_window_bottom"],
      ["a", "goto_last_accessed_file"],
      ["m", "goto_last_modified_file"],
      ["n", "goto_next_buffer"],
      ["p", "goto_previous_buffer"],
      ["k", "move_line_up"],
      ["j", "move_line_down"],
      [".", "goto_last_modification"],
      ["w", "goto_word"],
    ]),
  ],
  [":", "command_mode"],
  ["i", "insert_mode"],
  ["I", "insert_at_line_start"],
  ["a", "append_mode"],
  ["A", "insert_at_line_end"],
  ["o", "open_below"],
  ["O", "open_above"],
  ["d", "delete_selection"],
  ["A-d", "delete_selection_noyank"],
  ["c", "change_selection"],
  ["A-c", "change_selection_noyank"],
  ["C", "copy_selection_on_next_line"],
  ["A-C", "copy_selection_on_prev_line"],
  ["s", "select_regex"],
  ["A-s", "split_selection_on_newline"],
  ["A-minus", "merge_selections"],
  ["A-_", "merge_consecutive_selections"],
  ["S", "split_selection"],
  [";", "collapse_selection"],
  ["A-;", "flip_selections"],
  [["A-o", "A-up"], "expand_selection"],
  [["A-i", "A-down"], "shrink_selection"],
  [["A-I", "A-S-down"], "select_all_children"],
  [["A-p", "A-left"], "select_prev_sibling"],
  [["A-n", "A-right"], "select_next_sibling"],
  ["A-e", "move_parent_node_end"],
  ["A-b", "move_parent_node_start"],
  ["A-a", "select_all_siblings"],
  ["%", "select_all"],
  ["x", "extend_line_below"],
  ["X", "extend_to_line_bounds"],
  ["A-x", "shrink_to_line_bounds"],
  [
    "m",
    node("Match", [
      ["m", "match_brackets"],
      ["s", "surround_add"],
      ["r", "surround_replace"],
      ["d", "surround_delete"],
      [
        "i",
        node(
          "Match inside",
          [
            ["w", "select_textobject_inside_word"],
            ["W", "select_textobject_inside_WORD"],
            ["p", "select_textobject_inside_paragraph"],
            ["t", "select_textobject_inside_type"],
            ["f", "select_textobject_inside_function"],
            ["a", "select_textobject_inside_parameter"],
            ["c", "select_textobject_inside_comment"],
            ["T", "select_textobject_inside_test"],
            ["e", "select_textobject_inside_entry"],
            ["m", "select_textobject_inside_closest_surrounding_pair"],
            ["g", "select_textobject_inside_change"],
          ],
          { fallback: "select_textobject_inside_surrounding_pair" },
        ),
      ],
      [
        "a",
        node(
          "Match around",
          [
            ["w", "select_textobject_around_word"],
            ["W", "select_textobject_around_WORD"],
            ["p", "select_textobject_around_paragraph"],
            ["t", "select_textobject_around_type"],
            ["f", "select_textobject_around_function"],
            ["a", "select_textobject_around_parameter"],
            ["c", "select_textobject_around_comment"],
            ["T", "select_textobject_around_test"],
            ["e", "select_textobject_around_entry"],
            ["m", "select_textobject_around_closest_surrounding_pair"],
            ["g", "select_textobject_around_change"],
          ],
          { fallback: "select_textobject_around_surrounding_pair" },
        ),
      ],
    ]),
  ],
  [
    "[",
    node(
      "Left bracket",
      [
        ["d", "goto_prev_diag"],
        ["D", "goto_first_diag"],
        ["g", "goto_prev_change"],
        ["G", "goto_first_change"],
        ["f", "goto_prev_function"],
        ["t", "goto_prev_class"],
        ["a", "goto_prev_parameter"],
        ["c", "goto_prev_comment"],
        ["e", "goto_prev_entry"],
        ["T", "goto_prev_test"],
        ["p", "goto_prev_paragraph"],
        ["x", "goto_prev_xml_element"],
        ["space", "add_newline_above"],
      ],
      { fallback: "select_textobject_inside_prev_pair" },
    ),
  ],
  [
    "]",
    node(
      "Right bracket",
      [
        ["d", "goto_next_diag"],
        ["D", "goto_last_diag"],
        ["g", "goto_next_change"],
        ["G", "goto_last_change"],
        ["f", "goto_next_function"],
        ["t", "goto_next_class"],
        ["a", "goto_next_parameter"],
        ["c", "goto_next_comment"],
        ["e", "goto_next_entry"],
        ["T", "goto_next_test"],
        ["p", "goto_next_paragraph"],
        ["x", "goto_next_xml_element"],
        ["space", "add_newline_below"],
      ],
      { fallback: "select_textobject_inside_next_pair" },
    ),
  ],
  ["/", "search"],
  ["?", "rsearch"],
  ["n", "search_next"],
  ["N", "search_prev"],
  ["*", "search_selection_detect_word_boundaries"],
  ["A-*", "search_selection"],
  ["u", "undo"],
  ["U", "redo"],
  ["A-u", "earlier"],
  ["A-U", "later"],
  ["y", "yank"],
  ["p", "paste_after"],
  ["P", "paste_before"],
  ["Q", "record_macro"],
  ["q", "replay_macro"],
  [">", "indent"],
  ["<", "unindent"],
  ["=", "format_selections"],
  ["J", "join_selections"],
  ["A-J", "join_selections_space"],
  ["K", "keep_selections"],
  ["A-K", "remove_selections"],
  [",", "keep_primary_selection"],
  ["A-,", "remove_primary_selection"],
  ["&", "align_selections"],
  ["_", "trim_selections"],
  ["(", "rotate_selections_backward"],
  [")", "rotate_selections_forward"],
  ["A-(", "rotate_selection_contents_backward"],
  ["A-)", "rotate_selection_contents_forward"],
  ["A-:", "ensure_selections_forward"],
  ["esc", "normal_mode"],
  [["C-b", "pageup"], "page_up"],
  [["C-f", "pagedown"], "page_down"],
  ["C-u", "page_cursor_half_up"],
  ["C-d", "page_cursor_half_down"],
  ["C-w", node("Window", WINDOW_KEYS)],
  ["C-c", "toggle_comments"],
  [["C-i", "tab"], "jump_forward"],
  ["C-o", "jump_backward"],
  ["C-s", "save_selection"],
  [
    "space",
    node("Space", [
      ["f", "file_picker"],
      ["F", "file_picker_in_current_directory"],
      ["e", "file_explorer"],
      [".", "file_explorer_in_current_buffer_directory"],
      ["b", "buffer_picker"],
      ["j", "jumplist_picker"],
      ["s", "lsp_or_syntax_symbol_picker"],
      ["S", "lsp_or_syntax_workspace_symbol_picker"],
      ["d", "diagnostics_picker"],
      ["D", "workspace_diagnostics_picker"],
      ["g", "changed_file_picker"],
      ["a", "code_action"],
      ["'", "last_picker"],
      [
        "G",
        node(
          "Debug (experimental)",
          [
            ["l", "dap_launch"],
            ["r", "dap_restart"],
            ["b", "dap_toggle_breakpoint"],
            ["c", "dap_continue"],
            ["h", "dap_pause"],
            ["i", "dap_step_in"],
            ["o", "dap_step_out"],
            ["n", "dap_next"],
            ["v", "dap_variables"],
            ["t", "dap_terminate"],
            ["C-c", "dap_edit_condition"],
            ["C-l", "dap_edit_log"],
            [
              "s",
              node("Switch", [
                ["t", "dap_switch_thread"],
                ["f", "dap_switch_stack_frame"],
              ]),
            ],
            ["e", "dap_enable_exceptions"],
            ["E", "dap_disable_exceptions"],
          ],
          { sticky: true },
        ),
      ],
      ["w", node("Window", WINDOW_KEYS)],
      ["y", "yank_to_clipboard"],
      ["Y", "yank_main_selection_to_clipboard"],
      ["p", "paste_clipboard_after"],
      ["P", "paste_clipboard_before"],
      ["R", "replace_selections_with_clipboard"],
      ["/", "global_search"],
      ["k", "hover"],
      ["r", "rename_symbol"],
      ["h", "select_references_to_symbol_under_cursor"],
      ["c", "toggle_comments"],
      ["C", "toggle_block_comments"],
      ["A-c", "toggle_line_comments"],
      ["?", "command_palette"],
    ]),
  ],
  ["z", node("View", VIEW_KEYS)],
  ["Z", node("View", VIEW_KEYS, { sticky: true })],
  ['"', "select_register"],
  ["|", "shell_pipe"],
  ["A-|", "shell_pipe_to"],
  ["!", "shell_insert_output"],
  ["A-!", "shell_append_output"],
  ["$", "shell_keep_pipe"],
  ["C-z", "suspend"],
  ["C-a", "increment"],
  ["C-x", "decrement"],
]);

const SELECT = node("Select mode", [
  [["h", "left"], "extend_char_left"],
  [["j", "down"], "extend_visual_line_down"],
  [["k", "up"], "extend_visual_line_up"],
  [["l", "right"], "extend_char_right"],
  ["w", "extend_next_word_start"],
  ["b", "extend_prev_word_start"],
  ["e", "extend_next_word_end"],
  ["W", "extend_next_long_word_start"],
  ["B", "extend_prev_long_word_start"],
  ["E", "extend_next_long_word_end"],
  ["A-e", "extend_parent_node_end"],
  ["A-b", "extend_parent_node_start"],
  ["n", "extend_search_next"],
  ["N", "extend_search_prev"],
  ["t", "extend_till_char"],
  ["f", "extend_next_char"],
  ["T", "extend_till_prev_char"],
  ["F", "extend_prev_char"],
  ["home", "extend_to_line_start"],
  ["end", "extend_to_line_end"],
  ["esc", "exit_select_mode"],
  ["v", "normal_mode"],
  [
    "g",
    node("Goto", [
      ["g", "extend_to_file_start"],
      ["|", "extend_to_column"],
      ["e", "extend_to_last_line"],
      ["k", "extend_line_up"],
      ["j", "extend_line_down"],
      ["w", "extend_to_word"],
    ]),
  ],
]);

const INSERT = node("Insert mode", [
  ["esc", "normal_mode"],
  ["C-s", "commit_undo_checkpoint"],
  ["C-x", "completion"],
  ["C-r", "insert_register"],
  [["C-w", "A-backspace"], "delete_word_backward"],
  [["A-d", "A-del"], "delete_word_forward"],
  ["C-u", "kill_to_line_start"],
  ["C-k", "kill_to_line_end"],
  [["C-h", "backspace", "S-backspace"], "delete_char_backward"],
  [["C-d", "del"], "delete_char_forward"],
  [["C-j", "ret"], "insert_newline"],
  ["tab", "smart_tab"],
  ["S-tab", "insert_tab"],
  ["up", "move_visual_line_up"],
  ["down", "move_visual_line_down"],
  ["left", "move_char_left"],
  ["right", "move_char_right"],
  ["pageup", "page_up"],
  ["pagedown", "page_down"],
  ["home", "goto_line_start"],
  ["end", "goto_line_end_newline"],
]);

function rootNode(trie: KeyTrie): KeyTrieNode {
  if (trie.kind !== "node") throw new Error("a mode's keymap must be a node");
  return trie.node;
}

/** Helix's default keymap for each mode. Select mode is normal mode with its own keys on top. */
export function defaultKeymaps(): Record<Mode, KeyTrieNode> {
  const normal = rootNode(build(NORMAL));
  const select = rootNode(cloneTrie({ kind: "node", node: normal }));
  mergeNodes(select, rootNode(build(SELECT)));
  // Helix's select mode keeps normal mode's name in its help, but the root node is never shown.
  return { normal, select: { ...select, name: "Select mode" }, insert: rootNode(build(INSERT)) };
}

// ---- Keymaps from config ----

/** A problem with a keymap from config, naming where it is, such as `keys.normal.g.x`. */
export interface KeymapProblem {
  readonly path: string;
  readonly message: string;
}

/**
 * The keymaps with the user's config merged in, in Helix's format: a table per mode, mapping keys
 * to a command, a list of commands, or a table of more keys. Problems, such as a command with no
 * such name, are returned rather than thrown, and the keys they're on left out.
 */
export function keymapsWithConfig(config: unknown): {
  keymaps: Record<Mode, KeyTrieNode>;
  problems: KeymapProblem[];
} {
  const keymaps = defaultKeymaps();
  const problems: KeymapProblem[] = [];
  if (config === undefined || config === null) return { keymaps, problems };
  if (!isTable(config)) {
    problems.push({ path: "keys", message: "should be a table of modes" });
    return { keymaps, problems };
  }
  for (const [mode, table] of Object.entries(config)) {
    if (mode !== "normal" && mode !== "select" && mode !== "insert") {
      problems.push({
        path: `keys.${mode}`,
        message: "isn't a mode; the modes are normal, select and insert",
      });
      continue;
    }
    const parsed = parseNode(`keys.${mode}`, table, problems);
    if (parsed) mergeNodes(keymaps[mode], parsed);
  }
  return { keymaps, problems };
}

function isTable(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseNode(path: string, value: unknown, problems: KeymapProblem[]): KeyTrieNode | null {
  if (!isTable(value)) {
    problems.push({ path, message: "should be a table of keys" });
    return null;
  }
  const map = new Map<Key, KeyTrie>();
  for (const [rawKey, binding] of Object.entries(value)) {
    const keyPath = `${path}.${rawKey}`;
    let key: Key;
    try {
      key = parseKey(rawKey);
    } catch (e) {
      problems.push({ path: keyPath, message: (e as KeyError).message });
      continue;
    }
    const trie = parseTrie(keyPath, binding, problems);
    if (trie) map.set(key, trie);
  }
  return { name: "", map, sticky: false, fallback: null };
}

function parseTrie(path: string, value: unknown, problems: KeymapProblem[]): KeyTrie | null {
  const command = (s: unknown): MappableCommand | null => {
    if (typeof s !== "string") {
      problems.push({ path, message: "commands should be strings" });
      return null;
    }
    try {
      return parseCommand(s);
    } catch (e) {
      problems.push({ path, message: (e as Error).message });
      return null;
    }
  };
  if (typeof value === "string") {
    const c = command(value);
    return c ? { kind: "command", command: c } : null;
  }
  if (Array.isArray(value)) {
    const commands = value.map(command);
    if (commands.some((c) => c === null)) return null;
    return { kind: "sequence", commands: commands as MappableCommand[] };
  }
  const n = parseNode(path, value, problems);
  return n ? { kind: "node", node: n } : null;
}

// ---- Looking keys up ----

export type KeymapResult =
  | { readonly kind: "pending"; readonly node: KeyTrieNode }
  | { readonly kind: "matched"; readonly command: MappableCommand }
  | { readonly kind: "sequence"; readonly commands: readonly MappableCommand[] }
  | { readonly kind: "notFound" }
  /** The keys so far, including the one that didn't match. */
  | { readonly kind: "cancelled"; readonly keys: readonly Key[] }
  | { readonly kind: "fallback"; readonly command: string; readonly ch: string };

/** The keymaps, and the keys pressed so far that haven't yet matched a command. */
export class Keymaps {
  private state: Key[] = [];
  sticky: KeyTrieNode | null = null;

  constructor(readonly map: Record<Mode, KeyTrieNode>) {}

  pending(): readonly Key[] {
    return this.state;
  }

  /** Whether `key` is bound after the pending keys. */
  containsKey(mode: Mode, key: Key): boolean {
    const trie = search({ kind: "node", node: this.map[mode] }, this.state);
    return trie?.kind === "node" && trie.node.map.has(key);
  }

  get(mode: Mode, key: Key): KeymapResult {
    if (key === KEY.esc) {
      if (this.state.length > 0) {
        // The escape isn't included.
        return { kind: "cancelled", keys: this.state.splice(0) };
      }
      this.sticky = null;
    }
    const first = this.state[0] ?? key;
    const root: KeyTrie = { kind: "node", node: this.sticky ?? this.map[mode] };
    const trie = search(root, [first]);
    if (trie === null) return { kind: "notFound" };
    if (trie.kind === "command") return { kind: "matched", command: trie.command };
    if (trie.kind === "sequence") return { kind: "sequence", commands: trie.commands };

    this.state.push(key);
    const found = search(trie, this.state.slice(1));
    if (found?.kind === "node") {
      if (found.node.sticky) {
        this.state = [];
        this.sticky = found.node;
      }
      return { kind: "pending", node: found.node };
    }
    if (found?.kind === "command") {
      this.state = [];
      return { kind: "matched", command: found.command };
    }
    if (found?.kind === "sequence") {
      this.state = [];
      return { kind: "sequence", commands: found.commands };
    }
    const ch = keyChar(key);
    if (ch !== null) {
      const fallback = searchFallback(trie, this.state.slice(1));
      if (fallback !== null) {
        this.state = [];
        return { kind: "fallback", command: fallback, ch };
      }
    }
    return { kind: "cancelled", keys: this.state.splice(0) };
  }
}

function search(trie: KeyTrie, keys: readonly Key[]): KeyTrie | null {
  let current: KeyTrie = trie;
  for (const key of keys) {
    if (current.kind !== "node") return null;
    const next = current.node.map.get(key);
    if (next === undefined) return null;
    current = next;
  }
  return current;
}

function searchFallback(trie: KeyTrie, keys: readonly Key[]): string | null {
  let current: KeyTrie = trie;
  for (const [i, key] of keys.entries()) {
    if (current.kind !== "node") return null;
    const next = current.node.map.get(key);
    if (next === undefined) return i === keys.length - 1 ? current.node.fallback : null;
    current = next;
  }
  return null;
}

/** The lines of help for a node: its keys, grouped where they do the same thing. */
export function infobox(node: KeyTrieNode): { title: string; body: [string, string][] } {
  const body: [Key[], string][] = [];
  for (const [key, trie] of node.map) {
    let desc: string;
    if (trie.kind === "command") {
      if (trie.command.kind === "static" && trie.command.name === "no_op") continue;
      desc = commandDoc(trie.command);
    } else if (trie.kind === "node") {
      desc = trie.node.name || "…";
    } else {
      desc = "[Multiple commands]";
    }
    const existing = body.find(([, d]) => d === desc);
    if (existing) {
      existing[0].push(key);
    } else {
      body.push([[key], desc]);
    }
  }
  const lines: [string, string][] = body.map(([keys, desc]) => [keys.join(", "), desc]);
  if (node.fallback) lines.push(["...", FALLBACK_COMMANDS[node.fallback] ?? node.fallback]);
  return { title: node.name, body: lines };
}
