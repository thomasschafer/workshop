// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from tree-house and Helix (https://github.com/helix-editor/helix): tree-house's
// text_object.rs and helix-core's syntax.rs (`TextObjectQuery`).

import type { Node, Query } from "web-tree-sitter";
import { TREE_SITTER_MATCH_LIMIT } from "./locals";

/** A captured textobject span, either a single node or a non-empty quantifier group of nodes. */
export interface CapturedNode {
  readonly startIndex: number;
  readonly endIndex: number;
  readonly nodes: readonly Node[];
}

/**
 * Finds the first capture name in `captureNames` that exists in `query`, then executes `query`
 * on `root` and returns one `CapturedNode` per match that binds that capture (grouping multiple
 * quantified nodes from the same match into one span).
 */
export function captureNodesAny(
  query: Query,
  captureNames: readonly string[],
  root: Node,
): CapturedNode[] | null {
  let matchedName: string | null = null;
  for (const name of captureNames) {
    if (query.captureIndexForName(name) !== -1) {
      matchedName = name;
      break;
    }
  }
  if (matchedName === null) return null;

  const matches = query.matches(root, { matchLimit: TREE_SITTER_MATCH_LIMIT });
  const results: CapturedNode[] = [];
  for (const match of matches) {
    const nodes: Node[] = [];
    for (const cap of match.captures) {
      if (cap.name === matchedName) {
        nodes.push(cap.node);
      }
    }
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (first !== undefined && last !== undefined) {
      results.push({
        startIndex: first.startIndex,
        endIndex: last.endIndex,
        nodes,
      });
    }
  }
  return results;
}

/** Runs `query` for a single capture name (e.g. `"function.inside"`). */
export function captureNodes(query: Query, captureName: string, root: Node): CapturedNode[] | null {
  return captureNodesAny(query, [captureName], root);
}

/**
 * Whether a node captured as `captureName` covers `pos`, or `null` if the query has no such
 * capture. Ported from `helix-core/src/syntax.rs` `TextObjectQuery::capture_covers`.
 */
export function captureCovers(
  query: Query,
  captureName: string,
  root: Node,
  pos: number,
): boolean | null {
  if (query.captureIndexForName(captureName) === -1) return null;
  const matches = query.matches(root, {
    startIndex: pos,
    endIndex: pos + 1,
    matchLimit: TREE_SITTER_MATCH_LIMIT,
  });
  for (const match of matches) {
    for (const cap of match.captures) {
      if (cap.name === captureName && cap.node.startIndex <= pos && pos < cap.node.endIndex) {
        return true;
      }
    }
  }
  return false;
}
