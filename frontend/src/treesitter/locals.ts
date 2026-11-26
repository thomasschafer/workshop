// Port of `tree-house/src/locals.rs`: builds the lexical scope tree for a layer from `locals.scm`
// and supports O(log N) scope cursor advancement, scope-chain definition lookup, and incremental
// updates over dirty ranges.

import type { Edit, Tree } from "web-tree-sitter";
import type { LanguageBundle } from "./languages";
import type { TextSource } from "./textSource";

// Deliberately higher than tree-house's `TREE_SITTER_MATCH_LIMIT = 256` (`tree-house/src/lib.rs`).
// `tree-house-bindings` evaluates text predicates (`#eq?`, `#match?`, `#any-of?`) inline in Rust
// and immediately evicts failed matches from the cursor's in-progress pool, whereas
// `web-tree-sitter` runs C `ts_query_captures_wasm` to completion before filtering JS predicates.
// At 256, `haskell/highlights.scm` exceeds the limit on medium files and silently drops later
// captures such as `@local.reference`; 4096 keeps queries bounded without dropping valid captures.
export const TREE_SITTER_MATCH_LIMIT = 4096;

export interface LocalDefinition {
  /** Capture suffix after `"local.definition."` (e.g. `"variable.parameter"`). */
  readonly scopeSuffix: string;
  readonly startIndex: number;
  readonly endIndex: number;
}

export type LocalEvent =
  | {
      readonly kind: "scope";
      readonly startIndex: number;
      readonly endIndex: number;
      readonly inherit: boolean;
    }
  | {
      readonly kind: "def";
      readonly name: string;
      readonly scopeSuffix: string;
      readonly startIndex: number;
      readonly endIndex: number;
    };

export interface ScopeData {
  readonly definitions: Map<string, LocalDefinition>;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly inherit: boolean;
  readonly children: number[];
  readonly parent: number | null;
}

export class Locals {
  readonly scopes: ScopeData[];

  constructor() {
    this.scopes = [
      {
        definitions: new Map(),
        startIndex: 0,
        endIndex: Number.MAX_SAFE_INTEGER,
        inherit: false,
        children: [],
        parent: null,
      },
    ];
  }

  push(scope: ScopeData): number {
    if (scope.parent === null) {
      throw new Error("Locals.push cannot be used for the root scope");
    }
    const id = this.scopes.length;
    const parentScope = this.scopes[scope.parent];
    if (!parentScope) {
      throw new Error(`invalid parent scope ${scope.parent}`);
    }
    parentScope.children.push(id);
    this.scopes.push(scope);
    return id;
  }

  lookupReference(scopeId: number, name: string): LocalDefinition | null {
    let current: number | null = scopeId;
    while (current !== null) {
      const data: ScopeData | undefined = this.scopes[current];
      if (!data) break;
      const def = data.definitions.get(name);
      if (def) return def;
      if (!data.inherit) break;
      current = data.parent;
    }
    return null;
  }

  scopeCursor(pos: number): ScopeCursor {
    let scope = 0;
    const stack: { scope: number; childIdx: number }[] = [];
    for (;;) {
      const data = this.scopes[scope];
      if (!data) break;
      const childIdx = partitionPoint(data.children, (childId) => {
        const child = this.scopes[childId];
        return child !== undefined && child.endIndex < pos;
      });
      stack.push({ scope, childIdx });
      const childId = data.children[childIdx];
      if (childId === undefined) break;
      const child = this.scopes[childId];
      if (!child || pos < child.startIndex) break;
      scope = childId;
    }
    return new ScopeCursor(this, stack);
  }
}

export class ScopeCursor {
  readonly locals: Locals;
  private readonly stack: { scope: number; childIdx: number }[];

  constructor(locals: Locals, stack: { scope: number; childIdx: number }[]) {
    this.locals = locals;
    this.stack = stack;
  }

  advance(to: number): number {
    let top = this.stack.pop();
    if (!top) throw new Error("ScopeCursor stack is empty");
    let activeScope = top.scope;
    let childIdx = top.childIdx;

    for (;;) {
      const data = this.locals.scopes[activeScope];
      if (!data || to < data.endIndex) break;
      top = this.stack.pop();
      if (!top) throw new Error("ScopeCursor popped past root scope");
      activeScope = top.scope;
      childIdx = top.childIdx + 1;
    }

    outer: for (;;) {
      const data = this.locals.scopes[activeScope];
      if (!data) break;
      for (;;) {
        const childId = data.children[childIdx];
        if (childId === undefined) break outer;
        const child = this.locals.scopes[childId];
        if (!child || child.startIndex > to) break outer;
        if (to < child.endIndex) {
          this.stack.push({ scope: activeScope, childIdx });
          activeScope = childId;
          childIdx = 0;
          break;
        }
        childIdx++;
      }
    }

    this.stack.push({ scope: activeScope, childIdx });
    return activeScope;
  }

  currentScope(): number {
    const top = this.stack[this.stack.length - 1];
    if (!top) throw new Error("ScopeCursor stack is empty");
    return top.scope;
  }
}

function partitionPoint<T>(arr: readonly T[], pred: (item: T) => boolean): number {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    const item = arr[mid];
    if (item !== undefined && pred(item)) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

export interface LocalsResult {
  readonly locals: Locals;
  readonly events: LocalEvent[];
}

function captureLocalEvents(
  bundle: LanguageBundle,
  tree: Tree,
  source: TextSource,
  rangeStart?: number,
  rangeEnd?: number,
): LocalEvent[] {
  const localQuery = bundle.localQuery;
  if (!localQuery?.hasDefinitions) return [];

  const options =
    rangeStart !== undefined && rangeEnd !== undefined
      ? { startIndex: rangeStart, endIndex: rangeEnd, matchLimit: TREE_SITTER_MATCH_LIMIT }
      : { matchLimit: TREE_SITTER_MATCH_LIMIT };
  if (rangeStart !== undefined && rangeEnd !== undefined && rangeEnd <= rangeStart) {
    return [];
  }

  const captures = localQuery.query.captures(tree.rootNode, options);
  const events: LocalEvent[] = [];

  for (const cap of captures) {
    const start = cap.node.startIndex;
    const end = cap.node.endIndex;
    if (
      rangeStart !== undefined &&
      rangeEnd !== undefined &&
      !(start < rangeEnd && end > rangeStart)
    ) {
      continue;
    }
    if (cap.name === "local.scope") {
      events.push({
        kind: "scope",
        startIndex: start,
        endIndex: end,
        inherit: !localQuery.notScopeInherits.has(cap.patternIndex),
      });
    } else if (cap.name.startsWith("local.definition.")) {
      events.push({
        kind: "def",
        name: source.slice(start, end),
        scopeSuffix: cap.name.slice("local.definition.".length),
        startIndex: start,
        endIndex: end,
      });
    }
  }
  return events;
}

/** Materialises a `Locals` scope tree from a document-ordered list of `LocalEvent`s. */
export function buildLocalsFromEvents(events: readonly LocalEvent[]): Locals {
  const locals = new Locals();
  if (events.length === 0) return locals;
  let scope = 0;

  for (const ev of events) {
    while (ev.startIndex >= (locals.scopes[scope]?.endIndex ?? Number.MAX_SAFE_INTEGER)) {
      const parent = locals.scopes[scope]?.parent ?? null;
      if (parent === null) {
        throw new Error("root scope must cover entire document");
      }
      scope = parent;
    }

    if (ev.kind === "scope") {
      scope = locals.push({
        definitions: new Map(),
        startIndex: ev.startIndex,
        endIndex: ev.endIndex,
        inherit: ev.inherit,
        children: [],
        parent: scope,
      });
    } else {
      locals.scopes[scope]?.definitions.set(ev.name, {
        scopeSuffix: ev.scopeSuffix,
        startIndex: ev.startIndex,
        endIndex: ev.endIndex,
      });
    }
  }

  return locals;
}

/** Runs `locals.scm` over the full tree and returns both the `Locals` tree and its raw events. */
export function buildLocals(bundle: LanguageBundle, tree: Tree, source: TextSource): LocalsResult {
  const events = captureLocalEvents(bundle, tree, source);
  return { locals: buildLocalsFromEvents(events), events };
}

function compareEvents(a: LocalEvent, b: LocalEvent): number {
  if (a.startIndex !== b.startIndex) return a.startIndex - b.startIndex;
  // Enclosing scopes precede child definitions starting at the same index.
  if (a.kind !== b.kind) return a.kind === "scope" ? -1 : 1;
  return b.endIndex - a.endIndex;
}

/**
 * Incrementally updates `Locals` by shifting previous events outside `[dirtyStart, dirtyEnd)`
 * through `edits`, re-querying `locals.scm` only over `[dirtyStart, dirtyEnd)`, and merging.
 */
export function updateLocalsIncremental(
  prevEvents: readonly LocalEvent[],
  bundle: LanguageBundle,
  tree: Tree,
  source: TextSource,
  edits: readonly Edit[],
  dirtyStart: number,
  dirtyEnd: number,
): LocalsResult {
  const localQuery = bundle.localQuery;
  if (!localQuery?.hasDefinitions) {
    return { locals: new Locals(), events: [] };
  }
  if (dirtyStart <= 0 && dirtyEnd >= source.length) {
    return buildLocals(bundle, tree, source);
  }

  // Shift surviving events through ascending pre-edit `edits` in O(N + E), dropping any event that
  // touched an edit or whose post-edit span overlaps `[dirtyStart, dirtyEnd)`.
  const surviving: LocalEvent[] = [];
  let editIdx = 0;
  let offset = 0;

  for (const ev of prevEvents) {
    while (editIdx < edits.length && (edits[editIdx]?.oldEndIndex ?? 0) < ev.startIndex) {
      const e = edits[editIdx++];
      if (e) offset += e.newEndIndex - e.oldEndIndex;
    }
    const nextEdit = edits[editIdx];
    if (nextEdit && nextEdit.startIndex <= ev.endIndex) {
      // Touched an edit; re-captured by the dirty-range query below.
      continue;
    }
    const start = ev.startIndex + offset;
    const end = ev.endIndex + offset;
    if (start < dirtyEnd && end > dirtyStart) {
      continue;
    }
    if (ev.kind === "scope") {
      surviving.push({ kind: "scope", startIndex: start, endIndex: end, inherit: ev.inherit });
    } else {
      surviving.push({
        kind: "def",
        name: ev.name,
        scopeSuffix: ev.scopeSuffix,
        startIndex: start,
        endIndex: end,
      });
    }
  }

  const fresh = captureLocalEvents(bundle, tree, source, dirtyStart, dirtyEnd);

  // Stable merge of two already-sorted event lists.
  const merged: LocalEvent[] = new Array(surviving.length + fresh.length);
  let i = 0;
  let j = 0;
  let k = 0;
  while (i < surviving.length && j < fresh.length) {
    const a = surviving[i];
    const b = fresh[j];
    if (a && b && compareEvents(a, b) <= 0) {
      merged[k++] = a;
      i++;
    } else if (b) {
      merged[k++] = b;
      j++;
    }
  }
  while (i < surviving.length) {
    const a = surviving[i++];
    if (a) merged[k++] = a;
  }
  while (j < fresh.length) {
    const b = fresh[j++];
    if (b) merged[k++] = b;
  }
  merged.length = k;

  return { locals: buildLocalsFromEvents(merged), events: merged };
}
