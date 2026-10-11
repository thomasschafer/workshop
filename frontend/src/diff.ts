export const CURSOR = "‸";

export interface Change {
  from: number;
  to: number;
  insert: string;
}

export interface MarkedDoc {
  text: string;
  cursor: number;
}

export function markCursor(doc: string, cursor: number): string {
  if (doc.includes(CURSOR)) {
    throw new Error(`The code contains ${CURSOR}, which Workshop uses to mark the cursor.`);
  }
  return doc.slice(0, cursor) + CURSOR + doc.slice(cursor);
}

export function unmarkCursor(marked: string): MarkedDoc {
  const cursor = marked.indexOf(CURSOR);
  if (cursor < 0 || marked.indexOf(CURSOR, cursor + 1) >= 0) {
    throw new Error("Expected exactly one cursor marker.");
  }
  return { text: marked.slice(0, cursor) + marked.slice(cursor + 1), cursor };
}

/** The smallest single change turning `before` into `after`, or null if they're equal. */
export function minimalChange(before: string, after: string): Change | null {
  if (before === after) {
    return null;
  }
  let start = 0;
  const maxStart = Math.min(before.length, after.length);
  while (start < maxStart && before[start] === after[start]) {
    start++;
  }
  let endBefore = before.length;
  let endAfter = after.length;
  while (endBefore > start && endAfter > start && before[endBefore - 1] === after[endAfter - 1]) {
    endBefore--;
    endAfter--;
  }
  return { from: start, to: endBefore, insert: after.slice(start, endAfter) };
}
