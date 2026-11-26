// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-term's commands/syntax.rs.

import type { SyntaxTree } from "../treesitter";
import type { Doc } from "./text";

export type TagKind =
  | "class"
  | "constant"
  | "enum"
  | "field"
  | "function"
  | "interface"
  | "macro"
  | "module"
  | "section"
  | "struct"
  | "type";

const TAG_KINDS: ReadonlySet<string> = new Set<TagKind>([
  "class",
  "constant",
  "enum",
  "field",
  "function",
  "interface",
  "macro",
  "module",
  "section",
  "struct",
  "type",
]);

function parseTagKind(name: string): TagKind | null {
  return TAG_KINDS.has(name) ? (name as TagKind) : null;
}

export interface SyntaxTag {
  readonly kind: TagKind;
  readonly name: string;
  readonly start: number;
  readonly end: number;
  readonly startLine: number;
  readonly endLine: number;
}

/** Collects document symbols from `tags.scm` across all layers of `syntax`. */
export function collectSyntaxTags(syntax: SyntaxTree, doc: Doc): SyntaxTag[] {
  const tags: SyntaxTag[] = [];
  for (const { match } of syntax.matchesAcrossLayers("tags", doc.str)) {
    let defKind: TagKind | null = null;
    let defStart = 0;
    let defEnd = 0;
    let nameStart: number | null = null;
    let nameEnd: number | null = null;

    for (const cap of match.captures) {
      if (cap.name.startsWith("definition.")) {
        const kind = parseTagKind(cap.name.slice("definition.".length));
        if (kind !== null) {
          defKind = kind;
          defStart = cap.node.startIndex;
          defEnd = cap.node.endIndex;
        }
      } else if (cap.name === "name") {
        nameStart = cap.node.startIndex;
        nameEnd = cap.node.endIndex;
      }
    }

    if (defKind === null) continue;
    const nStart = nameStart ?? defStart;
    const nEnd = nameEnd ?? defEnd;
    tags.push({
      kind: defKind,
      name: doc.slice(nStart, nEnd),
      start: defStart,
      end: defEnd,
      startLine: doc.lineOf(defStart),
      endLine: doc.lineOf(defEnd),
    });
  }
  return tags;
}
