// Formatting the code, with the language server or the language's own formatter, changing only
// what formatting changes, so the cursor and what's in view stay where they were.

import { completionStatus } from "@codemirror/autocomplete";
import { isolateHistory } from "@codemirror/commands";
import { getIndentUnit, indentUnit } from "@codemirror/language";
import { type LSPClient, LSPPlugin } from "@codemirror/lsp-client";
import { diff } from "@codemirror/merge";
import { ChangeSet, type EditorState } from "@codemirror/state";
import { type EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { helixMode } from "./helix/view";
import { textEdits } from "./lspActions";
import { offsetIn } from "./lspEdits";

/** Formats code, or fails saying why it can't. */
export type Formatter = (code: string) => Promise<string>;

/** The user event of the change formatting makes. */
export const FORMAT_EVENT = "input.format";

/** How long Helix has to be left in normal mode, after a change, before the code's formatted. */
export const FORMAT_WHEN_SETTLED_MS = 3000;

/**
 * Formats the code in `view`, changing only what formatting changes, as one step to undo. Returns
 * whether it changed anything: nothing does if the code changed while it was being formatted,
 * which is left for the next time. Throws if it can't be formatted.
 */
export async function formatCode(view: EditorView, formatter: Formatter): Promise<boolean> {
  const before = view.state.doc.toString();
  const after = await formatter(before);
  if (view.state.doc.toString() !== before) return false;
  const changes = diff(before, after).map((c) => ({
    from: c.fromA,
    to: c.toA,
    insert: after.slice(c.fromB, c.toB),
  }));
  if (changes.length === 0) return false;
  view.dispatch({
    changes,
    userEvent: FORMAT_EVENT,
    annotations: isolateHistory.of("full"),
  });
  return true;
}

/** How code is indented, as the protocol's formatting options put it. */
function formattingOptions(state: EditorState): { tabSize: number; insertSpaces: boolean } {
  return { tabSize: getIndentUnit(state), insertSpaces: !state.facet(indentUnit).includes("\t") };
}

/**
 * Formats with the language server, if it formats, or returns null if it doesn't, or hasn't
 * started yet.
 */
export function languageServerFormatter(client: LSPClient, view: EditorView): Formatter | null {
  if (!client.serverCapabilities?.documentFormattingProvider) return null;
  return async (code) => {
    const plugin = LSPPlugin.get(view);
    if (plugin === null) throw new Error("the code isn't open with the language server");
    client.sync();
    const doc = plugin.syncedDoc;
    if (doc.toString() !== code) throw new Error("the language server has other code than this");
    const result = await client.request<unknown, unknown>("textDocument/formatting", {
      textDocument: { uri: plugin.uri },
      options: formattingOptions(view.state),
    });
    const edits = result === null ? [] : textEdits(result);
    const changes = edits.map((e) => ({
      from: offsetIn(doc, e.range.start),
      to: offsetIn(doc, e.range.end),
      insert: e.newText,
    }));
    return ChangeSet.of(changes, doc.length).apply(doc).toString();
  };
}

/**
 * Formats the code once, after a change, it's been left in Helix's normal mode for a moment
 * without moving, scrolling or a completion open, so it doesn't move under someone reading it.
 * Failures, such as for code that doesn't parse yet, are left until it's next changed, and so is
 * a format that's been undone.
 */
export function formatWhenSettled(format: (view: EditorView) => Promise<unknown>) {
  return ViewPlugin.fromClass(
    class {
      private changed = false;
      private timer: ReturnType<typeof setTimeout> | undefined;

      constructor(private readonly view: EditorView) {}

      update(update: ViewUpdate): void {
        // Neither formatting nor undoing it is a change to format, so an undone format stays.
        const edited = update.transactions.some(
          (tr) =>
            tr.docChanged &&
            !tr.isUserEvent(FORMAT_EVENT) &&
            !tr.isUserEvent("undo") &&
            !tr.isUserEvent("redo"),
        );
        if (edited) this.changed = true;
        if (
          update.docChanged ||
          update.selectionSet ||
          update.viewportChanged ||
          update.transactions.some((tr) => tr.effects.length > 0)
        ) {
          this.restart();
        }
      }

      private restart(): void {
        clearTimeout(this.timer);
        if (this.changed && this.settled()) {
          this.timer = setTimeout(() => this.format(), FORMAT_WHEN_SETTLED_MS);
        }
      }

      private settled(): boolean {
        const { state } = this.view;
        return helixMode(state) === "normal" && completionStatus(state) === null;
      }

      private format(): void {
        if (!this.settled()) return;
        this.changed = false;
        format(this.view).catch((error: unknown) => console.info("[format]", error));
      }

      destroy(): void {
        clearTimeout(this.timer);
      }
    },
  );
}
