import type { LabEdit } from "./types";

/**
 * The edits that save `edit` when the server has reached screen `reached`, and the learner has
 * been as far as `furthest` here. The server takes a lab one screen on at a time, but screens
 * moved through while a save was on its way, or offline, are only in the latest edit, so each
 * screen between is sent first, with what was recorded up to it.
 */
export function labEditsInTurn(edit: LabEdit, reached: number, furthest: number): LabEdit[] {
  const explainAt = edit.records.length + 1;
  const edits: LabEdit[] = [];
  for (let at = reached + 1; at <= Math.max(furthest, edit.at); at++) {
    if (at === edit.at && at >= furthest) break;
    edits.push({
      at,
      records: edit.records.map((record, i) => (i + 1 <= at ? record : "")),
      explanation: at === explainAt ? edit.explanation : "",
    });
  }
  edits.push(edit);
  return edits;
}
