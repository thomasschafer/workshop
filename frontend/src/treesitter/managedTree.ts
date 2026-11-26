// Reference-counted ownership wrapper around `web-tree-sitter` `Tree` handles.
//
// `web-tree-sitter` allocates trees in WASM linear memory, which JS garbage collectors do not
// account for when scheduling collection. `ManagedTree` provides deterministic refcounted deletion
// (so unchanged layers can be shared across EditorStates with zero copies, and evicted states free
// their WASM trees immediately) backed by a FinalizationRegistry safety net for GC'd standalone
// trees. Every underlying `Tree` is guaranteed to be `.delete()`d at most once.

import type { Edit, Tree } from "web-tree-sitter";

interface TreeCell {
  raw: Tree;
  deleted: boolean;
}

let liveTrees = 0;
let createdTrees = 0;
let deletedTrees = 0;

function deleteCell(cell: TreeCell): void {
  if (cell.deleted) return;
  cell.deleted = true;
  cell.raw.delete();
  liveTrees--;
  deletedTrees++;
}

const treeRegistry: FinalizationRegistry<TreeCell> | null =
  typeof FinalizationRegistry !== "undefined"
    ? new FinalizationRegistry<TreeCell>((cell) => {
        deleteCell(cell);
      })
    : null;

export interface TreeStats {
  readonly live: number;
  readonly created: number;
  readonly deleted: number;
}

/** Diagnostic counts of live/created/deleted WASM `Tree` wrappers (used by memory-leak tests). */
export function getTreeStats(): TreeStats {
  return { live: liveTrees, created: createdTrees, deleted: deletedTrees };
}

export class ManagedTree {
  private readonly cell: TreeCell;
  private refs = 1;

  constructor(raw: Tree) {
    this.cell = { raw, deleted: false };
    liveTrees++;
    createdTrees++;
    treeRegistry?.register(this, this.cell, this);
  }

  /** Returns the underlying WASM `Tree`, throwing if this handle has already been freed. */
  get raw(): Tree {
    if (this.cell.deleted) {
      throw new Error("attempted to access a deleted ManagedTree");
    }
    return this.cell.raw;
  }

  get isDeleted(): boolean {
    return this.cell.deleted;
  }

  /** Increments the reference count so another `SyntaxTree` can share this immutable tree. */
  retain(): ManagedTree {
    if (this.cell.deleted) {
      throw new Error("attempted to retain a deleted ManagedTree");
    }
    this.refs++;
    return this;
  }

  /** Decrements the reference count, immediately deleting the WASM tree when it reaches zero. */
  release(): void {
    if (this.refs <= 0) return;
    this.refs--;
    if (this.refs === 0) {
      treeRegistry?.unregister(this);
      deleteCell(this.cell);
    }
  }

  /** Creates a new `ManagedTree` via O(1) `Tree.copy()`, edited in place by `edits` in reverse. */
  copyWithEdits(edits: readonly Edit[]): ManagedTree {
    const copied = this.raw.copy();
    for (let i = edits.length - 1; i >= 0; i--) {
      const edit = edits[i];
      if (edit) copied.edit(edit);
    }
    return new ManagedTree(copied);
  }
}
