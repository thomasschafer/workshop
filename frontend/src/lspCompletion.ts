// Completions from the language server, as @codemirror/lsp-client's own source gives them, but
// finished as the server means them to be once one's chosen: with the edits that come with it,
// such as an import, those it gives only once asked, and any command it runs to make them, as the
// Haskell language server does to import what's completed.

import {
  type Completion,
  type CompletionContext,
  type CompletionResult,
  insertCompletionText,
  pickedCompletion,
  snippet,
} from "@codemirror/autocomplete";
import { LSPPlugin } from "@codemirror/lsp-client";
import { type ChangeDesc, ChangeSet, type ChangeSpec, type Text } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";
import { isRecord, type Range, textEdits } from "./lspActions";
import { placeEdits, withServerEdits } from "./lspEdits";

interface Command {
  readonly title: string;
  readonly command: string;
  readonly arguments?: unknown[];
}

interface MarkupContent {
  readonly kind: "markdown" | "plaintext";
  readonly value: string;
}

/**
 * More about a completion, shown beside its label: `detail` straight after it, such as a
 * function's parameters, and `description` after that, such as the module it's imported from.
 */
interface LabelDetails {
  readonly detail?: string;
  readonly description?: string;
}

/** A completion as the server sends it, which is sent back as it was to be resolved. */
interface CompletionItem {
  readonly label: string;
  readonly labelDetails?: LabelDetails;
  readonly kind?: number;
  readonly detail?: string;
  readonly documentation?: string | MarkupContent;
  readonly sortText?: string;
  readonly filterText?: string;
  readonly insertText?: string;
  readonly insertTextFormat?: number;
  readonly textEdit?: { readonly newText: string };
  readonly textEditText?: string;
  readonly additionalTextEdits?: unknown;
  readonly commitCharacters?: string[];
  readonly command?: Command;
  readonly data?: unknown;
}

type EditRange = Range | { readonly insert: Range; readonly replace: Range };

interface CompletionList {
  readonly isIncomplete?: boolean;
  readonly itemDefaults?: {
    readonly commitCharacters?: string[];
    readonly editRange?: EditRange;
    readonly insertTextFormat?: number;
  };
  readonly items: readonly CompletionItem[];
}

const INSERT_TEXT_SNIPPET = 2;
const TRIGGER_INVOKED = 1;
const TRIGGER_CHARACTER = 2;
const REQUEST_CANCELLED = -32800;

function completionItem(value: unknown): CompletionItem {
  if (!isRecord(value) || typeof value.label !== "string") {
    throw new Error("the language server sent a completion that can't be read");
  }
  if (value.command !== undefined) {
    const { command } = value;
    if (!isRecord(command) || typeof command.command !== "string") {
      throw new Error("the language server sent a completion whose command can't be read");
    }
  }
  if (value.labelDetails !== undefined) {
    const details = value.labelDetails;
    if (
      !isRecord(details) ||
      (details.detail !== undefined && typeof details.detail !== "string") ||
      (details.description !== undefined && typeof details.description !== "string")
    ) {
      throw new Error("the language server sent a completion whose label details can't be read");
    }
  }
  return value as unknown as CompletionItem;
}

function completionList(result: unknown): CompletionList | null {
  if (result === null || result === undefined) return null;
  if (Array.isArray(result)) return { items: result.map(completionItem) };
  if (isRecord(result) && Array.isArray(result.items)) {
    return { ...(result as unknown as CompletionList), items: result.items.map(completionItem) };
  }
  throw new Error("the language server's completions can't be read");
}

/** How @codemirror/autocomplete shows each kind of completion the protocol has. */
const KIND_TO_TYPE: Readonly<Record<number, string>> = {
  1: "text",
  2: "method",
  3: "function",
  4: "class",
  5: "property",
  6: "variable",
  7: "class",
  8: "interface",
  9: "namespace",
  10: "property",
  11: "keyword",
  12: "constant",
  13: "constant",
  14: "keyword",
  16: "constant",
  20: "constant",
  21: "constant",
  22: "class",
  25: "type",
};

/**
 * How a completion's shown: its label with the label details' `detail` straight after, and then,
 * as the protocol has editors do, their `description` in place of the completion's own `detail`
 * when there is one, as servers give it to say where an import's from.
 */
export function shownLabel(item: {
  readonly label: string;
  readonly labelDetails?: LabelDetails;
  readonly detail?: string;
}): { label: string; detail?: string } {
  const { labelDetails } = item;
  const detail = labelDetails?.description ?? item.detail;
  return {
    label: item.label + (labelDetails?.detail ?? ""),
    ...(detail !== undefined && detail !== "" && { detail }),
  };
}

/**
 * An LSP snippet in @codemirror/autocomplete's syntax, which has no backslash escapes and needs
 * braces around each field's number.
 */
export function lspToSnippet(text: string): string {
  return text.replace(/\\([$}\\])|\$(\d+)/g, (_m, escaped: string | undefined, field: string) =>
    escaped !== undefined ? escaped : `\${${field}}`,
  );
}

/** Whether, and why, to ask for completions here, as the protocol puts it, or null not to. */
function triggerFor(
  plugin: LSPPlugin,
  context: CompletionContext,
): { triggerKind: number; triggerCharacter?: string } | null {
  if (context.explicit) return { triggerKind: TRIGGER_INVOKED };
  const character = context.state.sliceDoc(context.pos - 1, context.pos);
  const triggers = plugin.client.serverCapabilities?.completionProvider?.triggerCharacters;
  if (triggers?.includes(character)) {
    return { triggerKind: TRIGGER_CHARACTER, triggerCharacter: character };
  }
  return /[a-zA-Z_]/.test(character) ? { triggerKind: TRIGGER_INVOKED } : null;
}

/** What completions replace, by the range the server gives or else the word being typed. */
function replacedRange(
  context: CompletionContext,
  list: CompletionList,
): { from: number; to: number } {
  const first = list.items[0];
  if (first === undefined) return { from: context.pos, to: context.pos };
  const fromItem = first.textEdit as { range?: Range; insert?: Range } | undefined;
  const range: EditRange | undefined =
    list.itemDefaults?.editRange ?? fromItem?.range ?? fromItem?.insert;
  if (range === undefined) {
    return context.state.wordAt(context.pos) ?? { from: context.pos, to: context.pos };
  }
  const insert = "insert" in range ? range.insert : range;
  const line = context.state.doc.lineAt(context.pos);
  return { from: line.from + insert.start.character, to: line.from + insert.end.character };
}

function insertText(item: CompletionItem): string {
  return item.textEdit?.newText || item.textEditText || item.insertText || item.label;
}

/**
 * What completions may go on being typed over before the server's asked again: the words they
 * complete, after any of the other characters some of them start with.
 */
function validFor(items: readonly CompletionItem[]): RegExp {
  const step = Math.ceil(items.length / 50);
  const prefixes = new Set<string>();
  for (let i = 0; i < items.length; i += step) {
    const prefix = /^[^\w]*/.exec(insertText(items[i] as CompletionItem))?.[0] ?? "";
    if (prefix !== "") prefixes.add(prefix);
  }
  if (prefixes.size === 0) return /^\w*$/;
  const escaped = [...prefixes].map((p) => p.replace(/[^\w\s]/g, "\\$&"));
  return new RegExp(`^(?:${escaped.join("|")})?\\w*$`);
}

/** The language server's completions, finished once chosen as the server means them to be. */
export function serverCompletionSource(
  context: CompletionContext,
): Promise<CompletionResult | null> | null {
  const plugin = context.view && LSPPlugin.get(context.view);
  if (!plugin || plugin.client.serverCapabilities?.completionProvider === undefined) return null;
  const trigger = triggerFor(plugin, context);
  if (trigger === null) return null;
  plugin.client.sync();
  const params = {
    position: plugin.toPosition(context.pos),
    textDocument: { uri: plugin.uri },
    context: trigger,
  };
  context.addEventListener("abort", () => plugin.client.cancelRequest(params));
  const requested = context.state.doc;
  return plugin.client.request<typeof params, unknown>("textDocument/completion", params).then(
    (result) => {
      const list = completionList(result);
      return list && completions(plugin, context, list, requested);
    },
    (error: unknown) => {
      if (isRecord(error) && error.code === REQUEST_CANCELLED) return null;
      throw error;
    },
  );
}

function completions(
  plugin: LSPPlugin,
  context: CompletionContext,
  list: CompletionList,
  requested: Text,
): CompletionResult {
  const { from, to } = replacedRange(context, list);
  const defaults = list.itemDefaults;
  const withEdits = list.items.some((item) => item.additionalTextEdits !== undefined);
  // Edits that come with a completion are to the code as it was asked for, so what's been typed
  // since, as the list's been narrowed, is kept track of to place them.
  const result = (sinceAsked: ChangeDesc): CompletionResult => ({
    from,
    to,
    options: list.items.map((item) => option(plugin, item, defaults, requested, sinceAsked)),
    ...(defaults?.commitCharacters && { commitCharacters: defaults.commitCharacters }),
    ...(!list.isIncomplete && { validFor: validFor(list.items) }),
    ...(withEdits && {
      map: (current: CompletionResult, changes: ChangeDesc) => ({
        ...current,
        options: result(sinceAsked.composeDesc(changes)).options,
      }),
    }),
  });
  return result(ChangeSet.empty(requested.length).desc);
}

function option(
  plugin: LSPPlugin,
  item: CompletionItem,
  defaults: CompletionList["itemDefaults"],
  requested: Text,
  sinceAsked: ChangeDesc,
): Completion {
  const text = insertText(item);
  const isSnippet = (item.insertTextFormat ?? defaults?.insertTextFormat) === INSERT_TEXT_SNIPPET;
  const { documentation } = item;
  const type = item.kind === undefined ? undefined : KIND_TO_TYPE[item.kind];
  const shown = shownLabel(item);
  return {
    label: item.filterText || item.label,
    displayLabel: shown.label,
    ...(type !== undefined && { type }),
    ...(shown.detail !== undefined && { detail: shown.detail }),
    ...(item.sortText !== undefined && { sortText: item.sortText }),
    ...(item.commitCharacters !== undefined &&
      item.commitCharacters !== defaults?.commitCharacters && {
        commitCharacters: item.commitCharacters,
      }),
    ...(documentation !== undefined && {
      info: () => {
        const info = document.createElement("div");
        info.className = "cm-lsp-documentation cm-lsp-completion-documentation";
        info.innerHTML = plugin.docToHTML(documentation);
        return info;
      },
    }),
    apply: (view, completion, from, to) => {
      const edits = item.additionalTextEdits;
      let extra: ChangeSpec[] = [];
      if (edits !== undefined) {
        const placed = placeEdits(requested, sinceAsked, textEdits(edits));
        if (placed === null) {
          plugin.reportError(
            "Couldn't finish the completion",
            new Error("the code it changes changed after it was offered"),
          );
        } else {
          extra = placed;
        }
      }
      insert(view, completion, from, to, text, isSnippet, extra);
      finish(view, plugin, item);
    },
  };
}

/** Puts the completion in, with `extra`, edits elsewhere in the code as it now is. */
function insert(
  view: EditorView,
  completion: Completion,
  from: number,
  to: number,
  text: string,
  isSnippet: boolean,
  extra: ChangeSpec[],
): void {
  if (!isSnippet) {
    // Both sets of changes are to the code as it is, as specs' changes are by default.
    view.dispatch(
      {
        ...insertCompletionText(view.state, text, from, to),
        annotations: pickedCompletion.of(completion),
      },
      { changes: extra },
    );
    return;
  }
  // A snippet makes its own change, so the others go first, with where it goes moved past them.
  if (extra.length > 0) {
    const tr = view.state.update({ changes: extra, userEvent: "input.complete" });
    view.dispatch(tr);
    from = tr.changes.mapPos(from, 1);
    to = tr.changes.mapPos(to, -1);
  }
  snippet(lspToSnippet(text))(view, completion, from, to);
}

/**
 * Does what the server leaves until a completion's chosen: gives the edits it didn't send with
 * it, when asked, and runs its command, which may ask Workshop to make edits of its own.
 */
function finish(view: EditorView, plugin: LSPPlugin, item: CompletionItem): void {
  const { client } = plugin;
  const resolvable =
    item.additionalTextEdits === undefined &&
    item.data !== undefined &&
    client.serverCapabilities?.completionProvider?.resolveProvider === true;
  if (!resolvable && item.command === undefined) return;
  withServerEdits(client, async (place) => {
    let command = item.command;
    if (resolvable) {
      const resolved = completionItem(
        await client.request<CompletionItem, unknown>("completionItem/resolve", item),
      );
      if (resolved.additionalTextEdits !== undefined) {
        const changes = place(plugin.uri, textEdits(resolved.additionalTextEdits));
        if (changes === null) {
          throw new Error("the code it changes changed before the language server answered");
        }
        client.workspace.updateFile(plugin.uri, { changes, userEvent: "input.complete" });
      }
      command = resolved.command ?? command;
    }
    if (command !== undefined) {
      client.sync();
      await client.request("workspace/executeCommand", {
        command: command.command,
        arguments: command.arguments,
      });
    }
  }).catch((error: unknown) => {
    if (view.dom.isConnected) plugin.reportError("Couldn't finish the completion", error);
    else console.error(error);
  });
}
