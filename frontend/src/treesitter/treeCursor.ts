// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from tree-house (https://github.com/helix-editor/helix): tree-house's tree_cursor.rs,
// walking across injection layers of a `SyntaxTree`.

import type { Node, TreeCursor } from "web-tree-sitter";
import type { SyntaxTree } from "./syntax";
import type { TextInput } from "./textSource";

/**
 * Multi-layer tree cursor over a `SyntaxTree`, crossing into and out of injection layers just as
 * tree-house's `TreeCursor` does. Always call `delete()` when finished so the underlying WASM
 * `TreeCursor` is freed immediately.
 */
export class SyntaxTreeCursor {
  private currentLayer: number;
  private cursor: TreeCursor;
  private deleted = false;

  constructor(
    private readonly syntax: SyntaxTree,
    private readonly input?: TextInput,
  ) {
    this.currentLayer = syntax.rootLayer;
    this.cursor = syntax.tree().walk();
  }

  /** Frees the underlying WASM `TreeCursor`. Safe to call more than once. */
  delete(): void {
    if (this.deleted) return;
    this.deleted = true;
    this.cursor.delete();
  }

  private replaceCursor(next: TreeCursor): void {
    if (!this.deleted) {
      this.cursor.delete();
    }
    this.deleted = false;
    this.cursor = next;
  }

  node(): Node {
    return this.cursor.currentNode;
  }

  gotoParent(): boolean {
    if (this.cursor.gotoParent()) {
      return true;
    }

    for (;;) {
      const parent = this.syntax.layer(this.currentLayer).parent;
      if (parent === null) {
        return false;
      }
      this.currentLayer = parent;
      const tree = this.syntax.layer(this.currentLayer).managedTree?.raw ?? null;
      if (tree !== null) {
        this.replaceCursor(tree.walk());
        return true;
      }
    }
  }

  gotoParentWith(predicate: (node: Node) => boolean): boolean {
    while (this.gotoParent()) {
      if (predicate(this.node())) {
        return true;
      }
    }
    return false;
  }

  gotoFirstChild(): boolean {
    const current = this.cursor.currentNode;
    const injection = this.syntax.layerInjectionAt(this.currentLayer, current.startIndex);
    if (injection !== null && injection.range.end >= current.endIndex) {
      const childTree =
        this.input !== undefined
          ? this.syntax.ensureLayerParsed(injection.layer, this.input)
          : (this.syntax.layer(injection.layer).managedTree?.raw ?? null);
      if (childTree !== null) {
        this.currentLayer = injection.layer;
        this.replaceCursor(childTree.walk());
        return true;
      }
    }

    return this.cursor.gotoFirstChild();
  }

  gotoNextSibling(): boolean {
    return this.cursor.gotoNextSibling();
  }

  gotoPreviousSibling(): boolean {
    return this.cursor.gotoPreviousSibling();
  }

  resetToRange(start: number, end: number): void {
    const { layer, tree } = this.syntax.layerAndTreeForRange(start, end, this.input);
    this.currentLayer = layer;
    this.replaceCursor(tree.walk());

    for (;;) {
      const node = this.cursor.currentNode;
      if (start < node.startIndex || end > node.endIndex) {
        this.cursor.gotoParent();
        break;
      }
      if (!this.cursor.gotoFirstChildForIndex(start)) {
        break;
      }
    }
  }

  /** Returns all direct children of the current node, advancing the cursor over them. */
  children(): Node[] {
    const out: Node[] = [];
    if (!this.gotoFirstChild()) {
      return out;
    }
    out.push(this.node());
    while (this.gotoNextSibling()) {
      out.push(this.node());
    }
    return out;
  }
}
