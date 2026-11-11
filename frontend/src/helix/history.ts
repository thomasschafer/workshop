// How undo steps are grouped when Helix's keybindings are on. Helix makes each normal mode
// command one undo step, and everything typed in one visit to insert mode another.

import { history } from "@codemirror/commands";
import { Annotation, type Extension, StateField } from "@codemirror/state";

/** The undo step a Helix command's change belongs to. Changes in the same step undo together. */
export const helixUndoGroup = Annotation.define<number>();

/** The undo step of the last change, so the next can tell whether it joins it. */
const lastGroup = StateField.define<number | null>({
  create: () => null,
  update: (group, tr) => (tr.docChanged ? (tr.annotation(helixUndoGroup) ?? null) : group),
});

/**
 * CodeMirror's history, grouping changes by the undo step Helix commands give them rather than
 * by how close together in time and place they are.
 */
export function helixHistory(): Extension {
  return [
    lastGroup,
    history({
      // Steps end when Helix ends them, however long they take.
      newGroupDelay: Number.MAX_SAFE_INTEGER,
      joinToEvent: (tr) => {
        const group = tr.annotation(helixUndoGroup);
        return group !== undefined && group === tr.startState.field(lastGroup);
      },
    }),
  ];
}
