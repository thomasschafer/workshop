// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's object.rs.

import type { SyntaxTree, SyntaxTreeCursor } from "../treesitter";
import { Direction, Range, type Selection } from "./selection";
import type { Doc } from "./text";

export function expandSelection(syntax: SyntaxTree, doc: Doc, selection: Selection): Selection {
  const cursor = syntax.walk(doc.str);
  try {
    return selection.transform((range) => {
      const from = range.from;
      const to = range.to;
      cursor.resetToRange(from, to);

      while (cursor.node().startIndex === from && cursor.node().endIndex === to) {
        if (!cursor.gotoParent()) {
          break;
        }
      }

      const node = cursor.node();
      return new Range(node.endIndex, node.startIndex).withDirection(range.direction);
    });
  } finally {
    cursor.delete();
  }
}

export function shrinkSelection(syntax: SyntaxTree, doc: Doc, selection: Selection): Selection {
  return selectNodeImpl(
    syntax,
    doc,
    selection,
    (cursor) => {
      cursor.gotoFirstChild();
    },
    null,
  );
}

export function selectNextSibling(syntax: SyntaxTree, doc: Doc, selection: Selection): Selection {
  return selectNodeImpl(
    syntax,
    doc,
    selection,
    (cursor) => {
      while (!cursor.gotoNextSibling()) {
        if (!cursor.gotoParent()) {
          break;
        }
      }
    },
    Direction.Forward,
  );
}

export function selectPrevSibling(syntax: SyntaxTree, doc: Doc, selection: Selection): Selection {
  return selectNodeImpl(
    syntax,
    doc,
    selection,
    (cursor) => {
      while (!cursor.gotoPreviousSibling()) {
        if (!cursor.gotoParent()) {
          break;
        }
      }
    },
    Direction.Backward,
  );
}

export function selectAllSiblings(syntax: SyntaxTree, doc: Doc, selection: Selection): Selection {
  const cursor = syntax.walk(doc.str);
  try {
    return selection.transformIter((range) => {
      cursor.resetToRange(range.from, range.to);
      if (!cursor.gotoParentWith((parent) => parent.childCount > 1)) {
        return [range];
      }
      return selectChildren(cursor, range);
    });
  } finally {
    cursor.delete();
  }
}

export function selectAllChildren(syntax: SyntaxTree, doc: Doc, selection: Selection): Selection {
  const cursor = syntax.walk(doc.str);
  try {
    return selection.transformIter((range) => {
      cursor.resetToRange(range.from, range.to);
      return selectChildren(cursor, range);
    });
  } finally {
    cursor.delete();
  }
}

function selectChildren(cursor: SyntaxTreeCursor, range: Range): Range[] {
  const children = cursor
    .children()
    .filter((child) => child.isNamed)
    .map((child) => new Range(child.startIndex, child.endIndex).withDirection(range.direction));
  return children.length > 0 ? children : [range];
}

function selectNodeImpl(
  syntax: SyntaxTree,
  doc: Doc,
  selection: Selection,
  motion: (cursor: SyntaxTreeCursor) => void,
  direction: Direction | null,
): Selection {
  const cursor = syntax.walk(doc.str);
  try {
    return selection.transform((range) => {
      cursor.resetToRange(range.from, range.to);
      motion(cursor);
      const node = cursor.node();
      return new Range(node.startIndex, node.endIndex).withDirection(direction ?? range.direction);
    });
  } finally {
    cursor.delete();
  }
}
