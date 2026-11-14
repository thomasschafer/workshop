// Edits a language server makes to files it knows as they were last sent to it, placed in the
// files as they are now, which may have changed since.

import type { LSPClient, WorkspaceMapping } from "@codemirror/lsp-client";
import type { ChangeDesc, ChangeSpec, Text } from "@codemirror/state";
import {
  editsByFile,
  isRecord,
  type Position,
  type TextEdit,
  type WorkspaceEdit,
} from "./lspActions";

/** The offset of `position` in `doc`, throwing if it's past the end, as the server's mistaken. */
export function offsetIn(doc: Text, position: Position): number {
  if (position.line >= doc.lines) {
    if (position.line === doc.lines && position.character === 0) return doc.length;
    throw new Error(`the language server sent a position past the end of the file`);
  }
  const line = doc.line(position.line + 1);
  // Past the end of a line means its end, as the protocol has it.
  return Math.min(line.from + position.character, line.to);
}

/**
 * Places edits a server made to the file at `uri`, as it was when `mapping` began, in the file as
 * it is now. Returns null if what they'd change has changed since, so they can't be placed.
 */
export type PlaceEdits = (uri: string, edits: readonly TextEdit[]) => ChangeSpec[] | null;

/**
 * Runs `f` with a way to place edits made to the open files as they now are on the server, so
 * those it answers with land where they were meant to, despite typing in the meantime.
 */
export function withServerEdits<T>(
  client: LSPClient,
  f: (place: PlaceEdits) => Promise<T>,
): Promise<T> {
  client.sync();
  return client.withMapping((mapping) => f(placing(client, mapping)));
}

/** Places edits made to the open files as they were sent to the server when `mapping` began. */
function placing(client: LSPClient, mapping: WorkspaceMapping): PlaceEdits {
  const docs = new Map(client.workspace.files.map((file) => [file.uri, file.doc]));
  return (uri, edits) => {
    const doc = docs.get(uri);
    const changes = mapping.getMapping(uri);
    if (doc === undefined || changes === null) {
      throw new Error(`the language server sent edits to ${uri}, which isn't open`);
    }
    return placeEdits(doc, changes, edits);
  };
}

/**
 * Places edits a server made to `doc` in the code it's become with `changes`, or returns null if
 * those changed what the edits would.
 */
export function placeEdits(
  doc: Text,
  changes: ChangeDesc,
  edits: readonly TextEdit[],
): ChangeSpec[] | null {
  const placed: ChangeSpec[] = [];
  for (const edit of edits) {
    const from = offsetIn(doc, edit.range.start);
    const to = offsetIn(doc, edit.range.end);
    if (changes.touchesRange(from, to)) return null;
    placed.push({
      from: changes.mapPos(from, 1),
      to: changes.mapPos(to, -1),
      insert: edit.newText,
    });
  }
  return placed;
}

/** What Workshop answers a server's `workspace/applyEdit` request with. */
export interface ApplyEditResult {
  readonly applied: boolean;
  readonly failureReason?: string;
}

/**
 * Makes the edit a server asks for with `workspace/applyEdit`, as it does once a completion's
 * command has worked out an import, to the open files. Makes none of it unless it can make all of
 * it, saying why not.
 */
export function applyWorkspaceEdit(client: LSPClient, params: unknown): ApplyEditResult {
  if (!isRecord(params) || !isRecord(params.edit)) {
    throw new Error("the language server asked to make an edit that can't be read");
  }
  const { byFile, elsewhere } = editsByFile(params.edit as WorkspaceEdit);
  if (elsewhere > 0) {
    return { applied: false, failureReason: "Workshop doesn't create, rename or delete files" };
  }
  // The server made the edit to what it was last sent, so nothing's sent before placing it.
  const mapping = client.workspaceMapping();
  const place = placing(client, mapping);
  try {
    const changes: [string, ChangeSpec[]][] = [];
    for (const [uri, edits] of byFile) {
      if (edits.length === 0) continue;
      if (client.workspace.getFile(uri)?.getView() == null) {
        return { applied: false, failureReason: `${uri} isn't open in Workshop` };
      }
      const placed = place(uri, edits);
      if (placed === null) {
        return { applied: false, failureReason: "the code it changes has changed since" };
      }
      changes.push([uri, placed]);
    }
    for (const [uri, placed] of changes) {
      client.workspace.updateFile(uri, { changes: placed, userEvent: "input" });
    }
    return { applied: true };
  } finally {
    mapping.destroy();
  }
}
