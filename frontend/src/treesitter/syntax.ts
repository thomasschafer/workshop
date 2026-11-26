// Multi-layer syntax tree (root + nested/combined injections + locals), ported from
// `tree-house/src/lib.rs`, `parse.rs`, and `injections_query.rs`.
//
// Performance & ownership design:
// - Every WASM `Tree` is owned via a refcounted `ManagedTree`, so unchanged layers are shared
//   between EditorStates with zero `tree.copy()` calls and released deterministically.
// - Non-root injection layers are parsed lazily on demand (`ensureLayerParsed`), avoiding eager
//   parsing and WASM allocations for off-screen comments/injections.
// - On incremental edits, `oldTree.getChangedRanges(newTree)` + edit ranges narrow both
//   `injections.scm` (for non-combined layers) and `locals.scm` to the affected declarations.

import type { ChangeSet, Text } from "@codemirror/state";
import {
  Edit,
  type Node,
  Parser,
  type Query,
  type QueryMatch,
  type Range,
  type Tree,
} from "web-tree-sitter";
import {
  getLoadedLanguageBundle,
  IncludedChildren,
  type LanguageBundle,
  type QueryKind,
  resolveInjectionLanguage,
} from "./languages";
import {
  buildLocals,
  type LocalEvent,
  Locals,
  TREE_SITTER_MATCH_LIMIT,
  updateLocalsIncremental,
} from "./locals";
import { ManagedTree } from "./managedTree";
import {
  advancePoint,
  asTextSource,
  pointAtDoc,
  type TextInput,
  type TextSource,
} from "./textSource";
import { SyntaxTreeCursor } from "./treeCursor";

/** Typed snapshot exposed synchronously via CodeMirror's `StateField` for later tree commands. */
export interface SyntaxSnapshot {
  readonly mode: string;
  readonly tree: Tree;
  readonly syntax: SyntaxTree;
  query(kind: QueryKind): Query | null;
}

export interface IndexRange {
  start: number;
  end: number;
}

export interface Injection {
  range: IndexRange;
  layer: number;
  matchedNodeRange: IndexRange;
}

interface LayerUpdateFlags {
  reused: boolean;
  modified: boolean;
  moved: boolean;
  touched: boolean;
}

export interface LayerData {
  readonly language: string;
  managedTree: ManagedTree | null;
  ranges: IndexRange[];
  /** Sorted, non-overlapping injection ranges within this layer (document-relative UTF-16 offsets). */
  injections: Injection[];
  flags: LayerUpdateFlags;
  readonly parent: number | null;
  locals: Locals;
  localEvents: LocalEvent[];
}

interface InjectionQueryMatch {
  readonly includeChildren: IncludedChildren;
  readonly language: string;
  readonly scopeKey: string | null;
  readonly node: Node;
  readonly lastMatch: boolean;
  readonly patternIndex: number;
  readonly startIndex: number;
  readonly endIndex: number;
}

// Matches tree-house's `SHEBANG` regex in `injections_query.rs`.
const SHEBANG_REGEX = /#!\s*(?:\S*[/\\](?:env\s+(?:-\S+\s+)*)?)?([^\s.\d]+)/;

let sharedParser: Parser | null = null;

function getParser(): Parser {
  if (!sharedParser) {
    sharedParser = new Parser();
  }
  return sharedParser;
}

/**
 * Converts a CodeMirror `ChangeSet` against `oldDoc` into ascending-order `Edit`s.
 * Callers apply these edits to tree-sitter trees in reverse order so earlier edits don't shift
 * later edit coordinates, matching `tree-house/src/parse.rs`.
 */
export function changeSetToEdits(oldDoc: Text, changes: ChangeSet): Edit[] {
  const edits: Edit[] = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    const insertedText = inserted.toString();
    const startPosition = pointAtDoc(oldDoc, fromA);
    const oldEndPosition = pointAtDoc(oldDoc, toA);
    const newEndPosition = advancePoint(startPosition, insertedText);
    edits.push(
      new Edit({
        startIndex: fromA,
        oldEndIndex: toA,
        newEndIndex: fromA + insertedText.length,
        startPosition,
        oldEndPosition,
        newEndPosition,
      }),
    );
  });
  return edits;
}

function emptyFlags(): LayerUpdateFlags {
  return { reused: false, modified: false, moved: false, touched: false };
}

function rangesIntersect(a: IndexRange, b: IndexRange): boolean {
  return a.start === b.start || (a.end > b.start && b.end > a.start);
}

/** Port of `tree-house/src/injections_query.rs` `exclude_ranges`. */
function excludeRanges(ranges: IndexRange[], excluded: IndexRange[]): IndexRange[] {
  const result: IndexRange[] = [];
  const nonEmptyExcluded = excluded.filter((r) => r.end > r.start);
  let exIdx = 0;

  for (const orig of ranges) {
    let curStart = orig.start;
    const curEnd = orig.end;
    while (curStart < curEnd) {
      while (exIdx < nonEmptyExcluded.length && (nonEmptyExcluded[exIdx]?.end ?? 0) <= curStart) {
        exIdx++;
      }
      const ex = nonEmptyExcluded[exIdx];
      if (ex && rangesIntersect({ start: curStart, end: curEnd }, ex)) {
        if (ex.start > curStart) {
          result.push({ start: curStart, end: ex.start });
        }
        if (ex.end < curEnd) {
          curStart = ex.end;
          exIdx++;
        } else {
          break;
        }
      } else {
        result.push({ start: curStart, end: curEnd });
        break;
      }
    }
  }
  return result;
}

/** Port of `tree-house/src/injections_query.rs` `intersect_ranges_impl`. */
function intersectRanges(
  includeChildren: IncludedChildren,
  node: Node,
  parentRanges: readonly IndexRange[],
): IndexRange[] {
  const nodeStart = node.startIndex;
  const nodeEnd = node.endIndex;
  if (nodeEnd <= nodeStart) return [];

  let pStart = 0;
  while (pStart < parentRanges.length && (parentRanges[pStart]?.end ?? 0) <= nodeStart) {
    pStart++;
  }
  const relevantParents = parentRanges.slice(pStart);

  const excluded: IndexRange[] = [];
  if (includeChildren !== IncludedChildren.All && node.childCount > 0) {
    for (const child of node.children) {
      if (includeChildren === IncludedChildren.None || child.isNamed) {
        excluded.push({ start: child.startIndex, end: child.endIndex });
      }
    }
  }

  const subtracted = excludeRanges(relevantParents, excluded);

  const merged: IndexRange[] = [];
  for (const r of subtracted) {
    const prev = merged[merged.length - 1];
    if (prev && prev.end === r.start) {
      prev.end = r.end;
    } else {
      merged.push({ start: r.start, end: r.end });
    }
  }

  const out: IndexRange[] = [];
  let curStart = nodeStart;
  for (const parent of merged) {
    if (curStart >= nodeEnd) break;
    if (parent.end <= curStart) continue;
    if (parent.start > curStart) curStart = parent.start;
    if (curStart >= nodeEnd) break;
    const segEnd = Math.min(nodeEnd, parent.end);
    if (segEnd > curStart) {
      out.push({ start: curStart, end: segEnd });
      curStart = segEnd;
    }
  }
  return out;
}

function executeInjectionQuery(
  bundle: LanguageBundle,
  rootNode: Node,
  source: TextSource,
  rangeStart?: number,
  rangeEnd?: number,
): InjectionQueryMatch[] {
  const inj = bundle.injectionQuery;
  if (!inj?.hasContentCapture) return [];
  if (rangeStart !== undefined && rangeEnd !== undefined && rangeEnd <= rangeStart) return [];

  const rawMatches: InjectionQueryMatch[] = [];
  const options =
    rangeStart !== undefined && rangeEnd !== undefined
      ? { startIndex: rangeStart, endIndex: rangeEnd, matchLimit: TREE_SITTER_MATCH_LIMIT }
      : { matchLimit: TREE_SITTER_MATCH_LIMIT };
  const matches = inj.query.matches(rootNode, options);

  for (let matchId = 0; matchId < matches.length; matchId++) {
    const match = matches[matchId];
    if (!match) continue;
    const props = inj.properties.get(match.patternIndex);

    let markerKind: "name" | "match" | null = null;
    let markerValue: string | null = null;
    const contentNodes: Node[] = [];

    for (const cap of match.captures) {
      if (cap.name === "injection.language") {
        markerKind = "match";
        markerValue = source.slice(cap.node.startIndex, cap.node.endIndex);
      } else if (cap.name === "injection.shebang") {
        const text = source.slice(cap.node.startIndex, cap.node.endIndex);
        const firstTwoLines = text.split("\n", 2).join("\n");
        const m = SHEBANG_REGEX.exec(firstTwoLines);
        if (m?.[1]) {
          markerKind = "match";
          markerValue = m[1];
        }
      } else if (cap.name === "injection.content") {
        contentNodes.push(cap.node);
      }
    }

    if (markerValue === null && props?.language) {
      markerKind = "name";
      markerValue = props.language;
    }
    if (markerKind === null || markerValue === null || contentNodes.length === 0) continue;

    const language = resolveInjectionLanguage(markerKind, markerValue);
    if (language === null || getLoadedLanguageBundle(language) === null) continue;

    const includeChildren = props?.includeChildren ?? IncludedChildren.None;
    const scopeKey = props?.combined
      ? `pattern:${match.patternIndex}:${language}`
      : contentNodes.length !== 1
        ? `match:${matchId}`
        : null;

    for (let i = 0; i < contentNodes.length; i++) {
      const node = contentNodes[i];
      if (!node) continue;
      const startIndex = node.startIndex;
      const endIndex = node.endIndex;
      if (endIndex <= startIndex) continue;
      if (
        rangeStart !== undefined &&
        rangeEnd !== undefined &&
        !(startIndex < rangeEnd && endIndex > rangeStart)
      ) {
        continue;
      }
      rawMatches.push({
        includeChildren,
        language,
        scopeKey,
        node,
        lastMatch: i === contentNodes.length - 1,
        patternIndex: match.patternIndex,
        startIndex,
        endIndex,
      });
    }
  }

  rawMatches.sort((a, b) => a.startIndex - b.startIndex || a.patternIndex - b.patternIndex);

  // Port of `InjectionsQuery::execute` overlap precedence resolution (`injections_query.rs` 317-355).
  const resolved: InjectionQueryMatch[] = [];
  let idx = 0;
  while (idx < rawMatches.length) {
    let res = rawMatches[idx++];
    if (!res) break;

    if (res.includeChildren === IncludedChildren.None) {
      let fastReturn = true;
      while (
        idx < rawMatches.length &&
        rawMatches[idx]?.startIndex === res.startIndex &&
        rawMatches[idx]?.endIndex === res.endIndex
      ) {
        const overlap = rawMatches[idx++];
        if (!overlap) break;
        if (overlap.includeChildren !== IncludedChildren.None) {
          const buf: InjectionQueryMatch[] = [res, overlap];
          while (idx < rawMatches.length && (rawMatches[idx]?.endIndex ?? 0) <= res.endIndex) {
            const next = rawMatches[idx++];
            if (next) buf.push(next);
          }
          buf.sort((a, b) => a.patternIndex - b.patternIndex || b.startIndex - a.startIndex);
          for (let j = buf.length - 1; j >= 0; j--) {
            const item = buf[j];
            if (item) resolved.push(item);
          }
          fastReturn = false;
          break;
        }
        res = overlap;
      }
      if (fastReturn) {
        resolved.push(res);
      }
      continue;
    }

    const buf: InjectionQueryMatch[] = [];
    while (idx < rawMatches.length && (rawMatches[idx]?.endIndex ?? 0) <= res.endIndex) {
      const overlap = rawMatches[idx++];
      if (overlap) buf.push(overlap);
    }
    if (buf.length === 0) {
      resolved.push(res);
    } else {
      buf.push(res);
      buf.sort((a, b) => a.patternIndex - b.patternIndex || b.startIndex - a.startIndex);
      for (let j = buf.length - 1; j >= 0; j--) {
        const item = buf[j];
        if (item) resolved.push(item);
      }
    }
  }

  return resolved;
}

/**
 * Expands the raw dirty span (from edits + `oldTree.getChangedRanges(newTree)`) to enclosing
 * top-level declaration siblings (plus one sibling on each side) so multi-node patterns and
 * deletions stay exact without rescanning the entire document.
 */
function computeDirtyRange(
  newRoot: Node,
  docLength: number,
  edits: readonly Edit[],
  changedRanges: readonly Range[],
): IndexRange {
  if (docLength === 0) return { start: 0, end: 0 };

  let minStart = docLength;
  let maxEnd = 0;

  let offset = 0;
  for (const edit of edits) {
    const postStart = edit.startIndex + offset;
    const postEnd = edit.newEndIndex + offset;
    offset += edit.newEndIndex - edit.oldEndIndex;
    if (postStart < minStart) minStart = postStart;
    if (postEnd > maxEnd) maxEnd = postEnd;
  }
  for (const r of changedRanges) {
    if (r.startIndex < minStart) minStart = r.startIndex;
    if (r.endIndex > maxEnd) maxEnd = r.endIndex;
  }

  minStart = Math.max(0, Math.min(minStart, docLength));
  maxEnd = Math.max(minStart, Math.min(maxEnd, docLength));

  // Descend into a single wrapping declarations container (e.g. Haskell's `(declarations ...)`),
  // if the dirty range lies inside it, so sibling expansion stays local.
  let container = newRoot;
  if (container.childCount > 0 && container.childCount <= 8) {
    const child = container.firstChildForIndex(minStart);
    if (child && child.childCount > 4 && child.startIndex <= minStart && child.endIndex >= maxEnd) {
      container = child;
    }
  }

  const startProbe = minStart > 0 ? minStart - 1 : 0;
  const firstChild = container.firstChildForIndex(startProbe);
  const leftNode = firstChild?.previousSibling ?? firstChild;
  const dirtyStart = leftNode ? Math.min(minStart, leftNode.startIndex) : 0;

  const lastChild = container.firstChildForIndex(maxEnd);
  const rightNode = lastChild?.nextSibling ?? lastChild;
  const dirtyEnd = rightNode ? Math.max(maxEnd, rightNode.endIndex) : docLength;

  return {
    start: Math.max(0, dirtyStart),
    end: Math.min(docLength, Math.max(dirtyStart, dirtyEnd)),
  };
}

export class SyntaxTree {
  readonly rootLayer = 0;
  private readonly layers = new Map<number, LayerData>();
  private nextLayerId = 1;

  private constructor(rootLanguage: string) {
    this.layers.set(0, {
      language: rootLanguage,
      managedTree: null,
      ranges: [{ start: 0, end: Number.MAX_SAFE_INTEGER }],
      injections: [],
      flags: emptyFlags(),
      parent: null,
      locals: new Locals(),
      localEvents: [],
    });
  }

  /** Parses `source` from scratch for `rootLanguage` (non-root injection layers parse lazily). */
  static parse(input: TextInput, rootLanguage: string): SyntaxTree {
    const syntax = new SyntaxTree(rootLanguage);
    syntax.update(input, []);
    return syntax;
  }

  /** Releases all `ManagedTree` references owned by this `SyntaxTree`. */
  delete(): void {
    for (const layer of this.layers.values()) {
      layer.managedTree?.release();
      layer.managedTree = null;
    }
    this.layers.clear();
  }

  layer(id: number): LayerData {
    const data = this.layers.get(id);
    if (!data) throw new Error(`missing syntax layer ${id}`);
    return data;
  }

  /** Language name of the root parse layer. */
  rootLanguage(): string {
    return this.layer(this.rootLayer).language;
  }

  /** Root parse tree. Always present after `parse` / `update`. */
  tree(): Tree {
    const rootTree = this.layer(this.rootLayer).managedTree;
    if (!rootTree) throw new Error("root syntax layer has no parse tree");
    return rootTree.raw;
  }

  /** Returns the direct injection in `layerId` covering `pos`, if any. */
  layerInjectionAt(layerId: number, pos: number): Injection | null {
    return injectionAt(this.layer(layerId).injections, pos);
  }

  /** Compiles/returns the auxiliary query `kind` for `layerId`, or `null` if unavailable. */
  queryForLayer(layerId: number, kind: QueryKind): Query | null {
    const bundle = getLoadedLanguageBundle(this.layer(layerId).language);
    return bundle?.query(kind) ?? null;
  }

  /** Creates a multi-layer tree cursor starting at the root node. Call `.delete()` when done. */
  walk(input?: TextInput): SyntaxTreeCursor {
    return new SyntaxTreeCursor(this, input);
  }

  /**
   * Produces a new `SyntaxTree` sharing all unchanged layers' `ManagedTree`s via refcounting
   * (zero `tree.copy()` calls), then applies `edits` incrementally without mutating `this`.
   */
  cloneForEdit(): SyntaxTree {
    const copy = new SyntaxTree(this.layer(this.rootLayer).language);
    copy.layers.clear();
    copy.nextLayerId = this.nextLayerId;
    for (const [id, data] of this.layers) {
      copy.layers.set(id, {
        language: data.language,
        managedTree: data.managedTree ? data.managedTree.retain() : null,
        ranges: data.ranges.length === 0 ? [] : data.ranges.map((r) => ({ ...r })),
        injections:
          data.injections.length === 0
            ? []
            : data.injections.map((inj) => ({
                layer: inj.layer,
                range: { ...inj.range },
                matchedNodeRange: { ...inj.matchedNodeRange },
              })),
        flags: { ...data.flags },
        parent: data.parent,
        locals: data.locals,
        localEvents: data.localEvents,
      });
    }
    return copy;
  }

  /**
   * Lazily parses a non-root injection layer (and discovers its nested injections/locals) on first
   * access. Returns the layer's `Tree`, or `null` if its grammar isn't loaded or it has no ranges.
   */
  ensureLayerParsed(layerId: number, input: TextInput): Tree | null {
    const data = this.layer(layerId);
    if (data.managedTree !== null) return data.managedTree.raw;
    if (data.ranges.length === 0) return null;

    const bundle = getLoadedLanguageBundle(data.language);
    if (!bundle) return null;

    const source = asTextSource(input);
    const parser = getParser();
    const parsedTree = this.parseLayer(parser, data, bundle, source, null);

    // Discover nested injections and locals inside this newly parsed child layer.
    this.runFullInjectionQuery(layerId, source, bundle, false);
    if (bundle.localQuery?.hasDefinitions) {
      const built = buildLocals(bundle, parsedTree.raw, source);
      data.locals = built.locals;
      data.localEvents = built.events;
    }
    // Reset flags set by runFullInjectionQuery during lazy hydration.
    for (const child of data.injections) {
      const childLayer = this.layers.get(child.layer);
      if (childLayer) childLayer.flags = emptyFlags();
    }
    return parsedTree.raw;
  }

  /** Finds the smallest injection layer that fully includes `[start, end]`. */
  layerForRange(start: number, end: number): number {
    let current = this.rootLayer;
    for (;;) {
      const data = this.layer(current);
      const atStart = injectionAt(data.injections, start);
      const atEnd = injectionAt(data.injections, end);
      if (atStart && atEnd && atStart.layer === atEnd.layer) {
        current = atStart.layer;
      } else {
        return current;
      }
    }
  }

  /** Finds the smallest layer with a parse tree covering `[start, end]`, parsing lazy layers if needed. */
  layerAndTreeForRange(
    start: number,
    end: number,
    input?: TextInput,
  ): { layer: number; tree: Tree } {
    let id = this.layerForRange(start, end);
    for (;;) {
      const data = this.layer(id);
      if (data.managedTree) return { layer: id, tree: data.managedTree.raw };
      if (input !== undefined) {
        const parsed = this.ensureLayerParsed(id, input);
        if (parsed) return { layer: id, tree: parsed };
      }
      if (data.parent === null) throw new Error("root layer has no tree");
      id = data.parent;
    }
  }

  /** Finds the smallest parse tree covering `[start, end]`, parsing lazy layers if needed. */
  treeForRange(start: number, end: number, input?: TextInput): Tree {
    return this.layerAndTreeForRange(start, end, input).tree;
  }

  /** Smallest node covering `[start, end]` in the innermost parse tree covering that range. */
  descendantForRange(start: number, end: number, input?: TextInput): Node | null {
    return this.treeForRange(start, end, input).rootNode.descendantForIndex(start, end);
  }

  /** Smallest named node covering `[start, end]` in the innermost parse tree covering that range. */
  namedDescendantForRange(start: number, end: number, input?: TextInput): Node | null {
    return this.treeForRange(start, end, input).rootNode.namedDescendantForIndex(start, end);
  }

  /**
   * Executes auxiliary query `kind` across the root layer and any nested injection layers in
   * document order, matching tree-house's `QueryMatchIter` (used by `tags.scm`).
   */
  matchesAcrossLayers(
    kind: QueryKind,
    input: TextInput,
  ): { readonly language: string; readonly query: Query; readonly match: QueryMatch }[] {
    const out: { readonly language: string; readonly query: Query; readonly match: QueryMatch }[] =
      [];
    const source = asTextSource(input);
    const visit = (layerId: number, boundStart: number, boundEnd: number): void => {
      const data = this.layer(layerId);
      const tree = data.managedTree?.raw ?? this.ensureLayerParsed(layerId, source);
      if (!tree) return;
      const query = this.queryForLayer(layerId, kind);
      const matches = query
        ? query.matches(tree.rootNode, {
            startIndex: boundStart,
            endIndex: boundEnd,
            matchLimit: TREE_SITTER_MATCH_LIMIT,
          })
        : [];
      const injections = data.injections.filter(
        (inj) => inj.range.end > boundStart && inj.range.start < boundEnd,
      );
      let mi = 0;
      let ii = 0;
      const matchBounds = (m: QueryMatch): { start: number; end: number } => {
        let start = Number.MAX_SAFE_INTEGER;
        let end = 0;
        for (const cap of m.captures) {
          if (cap.node.startIndex < start) start = cap.node.startIndex;
          if (cap.node.endIndex > end) end = cap.node.endIndex;
        }
        return start === Number.MAX_SAFE_INTEGER ? { start: 0, end: 0 } : { start, end };
      };

      while (mi < matches.length || ii < injections.length) {
        const m = matches[mi];
        const inj = injections[ii];
        if (m !== undefined) {
          const b = matchBounds(m);
          if (b.start === b.end) {
            mi++;
            continue;
          }
          if (inj === undefined || b.start < inj.range.end) {
            mi++;
            if (
              query &&
              (inj === undefined || b.start <= inj.range.start || inj.range.end < b.end)
            ) {
              out.push({ language: data.language, query, match: m });
            }
            continue;
          }
        }
        if (inj !== undefined) {
          ii++;
          visit(
            inj.layer,
            Math.max(boundStart, inj.range.start),
            Math.min(boundEnd, inj.range.end),
          );
        }
      }
    };

    const rootNode = this.tree().rootNode;
    visit(this.rootLayer, rootNode.startIndex, rootNode.endIndex);
    return out;
  }

  /**
   * Incrementally updates the root layer, updates injections and locals over the dirty range,
   * shifts or invalidates already-parsed child layers, and prunes dead layers.
   */
  update(input: TextInput, edits: readonly Edit[]): void {
    const source = asTextSource(input);
    const parser = getParser();

    const root = this.layer(this.rootLayer);
    const rootBundle = getLoadedLanguageBundle(root.language);
    if (!rootBundle) {
      throw new Error(`language bundle not loaded for ${root.language}`);
    }

    root.flags.touched = true;
    root.flags.modified = true;

    const isIncremental = root.managedTree !== null && edits.length > 0;
    let dirtyRange: IndexRange | null = null;
    let rootTree: ManagedTree;

    if (isIncremental && root.managedTree) {
      const prevManaged = root.managedTree;
      const editedCopy = prevManaged.copyWithEdits(edits);
      prevManaged.release();
      root.managedTree = null;

      try {
        rootTree = this.parseLayer(parser, root, rootBundle, source, editedCopy);
        const changedRanges = editedCopy.raw.getChangedRanges(rootTree.raw);
        dirtyRange = computeDirtyRange(rootTree.raw.rootNode, source.length, edits, changedRanges);
      } finally {
        editedCopy.release();
      }
    } else {
      rootTree = this.parseLayer(parser, root, rootBundle, source, null);
    }

    const canUseIncrementalInjections =
      isIncremental &&
      dirtyRange !== null &&
      !rootBundle.injectionQuery?.hasCombinedPattern &&
      !(dirtyRange.start <= 0 && dirtyRange.end >= source.length);

    if (canUseIncrementalInjections && dirtyRange) {
      this.runIncrementalInjectionQuery(this.rootLayer, edits, source, rootBundle, dirtyRange);
    } else {
      this.mapInjections(this.rootLayer, edits);
      this.runFullInjectionQuery(this.rootLayer, source, rootBundle, true);
    }

    if (isIncremental && dirtyRange) {
      const updated = updateLocalsIncremental(
        root.localEvents,
        rootBundle,
        rootTree.raw,
        source,
        edits,
        dirtyRange.start,
        dirtyRange.end,
      );
      root.locals = updated.locals;
      root.localEvents = updated.events;
    } else {
      const built = buildLocals(rootBundle, rootTree.raw, source);
      root.locals = built.locals;
      root.localEvents = built.events;
    }

    // Update any already-parsed child layers (unparsed lazy layers stay `managedTree: null`).
    const childQueue: number[] = [];
    for (const [id, data] of this.layers) {
      if (id !== this.rootLayer && data.flags.touched) {
        childQueue.push(id);
      }
    }
    while (childQueue.length > 0) {
      const childId = childQueue.pop();
      if (childId === undefined) break;
      const data = this.layer(childId);
      if (data.ranges.length === 0 || !data.managedTree) continue;

      if (data.flags.modified || data.flags.moved) {
        // Release modified or offset-shifted child trees so they re-parse lazily against the new
        // document text only if accessed. Keeping a shifted `web-tree-sitter` Tree would retain
        // its old `textCallback` (breaking `#eq?`/`#any-of?`/`#match?` predicates at new offsets).
        data.managedTree.release();
        data.managedTree = null;
        data.injections = [];
        data.locals = new Locals();
        data.localEvents = [];
      } else {
        // Unchanged & unmoved child layer: mark its existing nested children touched too.
        for (const grand of data.injections) {
          const grandLayer = this.layers.get(grand.layer);
          if (grandLayer && !grandLayer.flags.touched) {
            grandLayer.flags.touched = true;
            childQueue.push(grand.layer);
          }
        }
      }
    }

    // Prune dead layers and immediately release their WASM trees.
    for (const [id, data] of this.layers) {
      const touched = data.flags.touched;
      data.flags = emptyFlags();
      if (!touched) {
        data.managedTree?.release();
        data.managedTree = null;
        this.layers.delete(id);
      }
    }
  }

  private parseLayer(
    parser: Parser,
    data: LayerData,
    bundle: LanguageBundle,
    source: TextSource,
    editedOldTree: ManagedTree | null,
  ): ManagedTree {
    if (parser.language !== bundle.language) {
      parser.setLanguage(bundle.language);
    }

    const isRoot = data.parent === null;
    let includedRanges: Range[] | undefined;
    if (!isRoot) {
      includedRanges = data.ranges.map((r) => ({
        startIndex: r.start,
        endIndex: r.end,
        startPosition: source.pointAt(r.start),
        endPosition: source.pointAt(r.end),
      }));
    }

    // Match tree-house's workaround in `parse.rs` (helix#12972): don't pass `oldTree` when a
    // combined injection's new ranges extend outside the old tree's span.
    let reuseTree: Tree | null = editedOldTree ? editedOldTree.raw : null;
    if (reuseTree && !isRoot) {
      const first = data.ranges[0];
      const last = data.ranges[data.ranges.length - 1];
      if (first && last) {
        const treeStart = reuseTree.rootNode.startIndex;
        const treeEnd = reuseTree.rootNode.endIndex;
        if (treeStart > first.start || treeEnd < last.end) {
          reuseTree = null;
        }
      }
    }

    const parsed = parser.parse(
      source.text,
      reuseTree,
      includedRanges ? { includedRanges } : undefined,
    );
    if (!parsed) {
      throw new Error(`tree-sitter parse returned null for ${data.language}`);
    }
    const managed = new ManagedTree(parsed);
    data.managedTree?.release();
    data.managedTree = managed;
    return managed;
  }

  /**
   * Incremental injection update for layers without `#set! injection.combined`: preserves shifted
   * injections strictly outside `dirtyRange` and only queries `injections.scm` inside `dirtyRange`.
   */
  private runIncrementalInjectionQuery(
    layerId: number,
    edits: readonly Edit[],
    source: TextSource,
    bundle: LanguageBundle,
    dirtyRange: IndexRange,
  ): void {
    this.mapInjections(layerId, edits);
    const data = this.layer(layerId);
    if (!bundle.injectionQuery?.hasContentCapture || !data.managedTree) return;

    const parentRanges = data.ranges;
    const oldInjections = data.injections;

    const prefix: Injection[] = [];
    const middleOld: Injection[] = [];
    const suffix: Injection[] = [];

    const clearedSuffixLayers = new Set<number>();
    for (const inj of oldInjections) {
      if (inj.matchedNodeRange.end <= dirtyRange.start) {
        prefix.push(inj);
        const child = this.layers.get(inj.layer);
        if (child) child.flags.touched = true;
      } else if (inj.matchedNodeRange.start >= dirtyRange.end) {
        suffix.push(inj);
        const child = this.layers.get(inj.layer);
        if (child) {
          child.flags.touched = true;
          // Refresh shifted ranges on suffix layers so lazy re-parsing uses post-edit offsets.
          if (child.flags.moved) {
            if (!clearedSuffixLayers.has(inj.layer)) {
              clearedSuffixLayers.add(inj.layer);
              child.ranges = [];
            }
            child.ranges.push({ ...inj.range });
          }
        }
      } else {
        middleOld.push(inj);
      }
    }

    const matches = executeInjectionQuery(
      bundle,
      data.managedTree.raw.rootNode,
      source,
      dirtyRange.start,
      dirtyRange.end,
    );

    const middleNew = this.buildInjectionsFromMatches(
      layerId,
      matches,
      parentRanges,
      middleOld,
      true,
    );

    // Ensure any suffix/prefix boundary stays strictly non-overlapping (defensive guard).
    data.injections = [...prefix, ...middleNew, ...suffix];
  }

  private runFullInjectionQuery(
    layerId: number,
    source: TextSource,
    bundle: LanguageBundle,
    markTouched: boolean,
  ): void {
    const data = this.layer(layerId);
    if (!bundle.injectionQuery?.hasContentCapture || !data.managedTree) return;

    const matches = executeInjectionQuery(bundle, data.managedTree.raw.rootNode, source);
    data.injections = this.buildInjectionsFromMatches(
      layerId,
      matches,
      data.ranges,
      data.injections,
      markTouched,
    );
  }

  private buildInjectionsFromMatches(
    parentLayerId: number,
    matches: readonly InjectionQueryMatch[],
    parentRanges: readonly IndexRange[],
    oldInjections: readonly Injection[],
    markTouched: boolean,
  ): Injection[] {
    let oldIdx = 0;
    const newInjections: Injection[] = [];
    const combinedLayers = new Map<string, number>();

    for (const mat of matches) {
      const matchedNodeRange: IndexRange = { start: mat.startIndex, end: mat.endIndex };
      let insertPosition = newInjections.length;

      const lastInj = newInjections[newInjections.length - 1];
      if (lastInj && rangesIntersect(lastInj.range, matchedNodeRange)) {
        if (lastInj.range.start <= matchedNodeRange.start) {
          continue;
        }
        insertPosition = partitionPoint(
          newInjections,
          (inj) => inj.range.end <= matchedNodeRange.start,
        );
        const atPos = newInjections[insertPosition];
        if (atPos && atPos.range.start < matchedNodeRange.end) {
          continue;
        }
      }

      let reused: Injection | null = null;
      while (
        oldIdx < oldInjections.length &&
        (oldInjections[oldIdx]?.range.end ?? 0) <= matchedNodeRange.start
      ) {
        const skipped = oldInjections[oldIdx++];
        if (skipped) {
          const skippedLayer = this.layers.get(skipped.layer);
          if (skippedLayer) skippedLayer.flags.modified = true;
        }
      }
      const candidate = oldInjections[oldIdx];
      if (candidate && candidate.range.start < matchedNodeRange.end) {
        const candLayer = this.layers.get(candidate.layer);
        if (candLayer && candLayer.language === mat.language && !candLayer.flags.reused) {
          reused = candidate;
          oldIdx++;
        }
      }

      let childLayerId: number;
      if (mat.scopeKey !== null) {
        const existing = combinedLayers.get(mat.scopeKey);
        if (existing !== undefined) {
          childLayerId = existing;
          if (mat.lastMatch && mat.scopeKey.startsWith("match:")) {
            combinedLayers.delete(mat.scopeKey);
          }
        } else {
          childLayerId = this.initInjection(parentLayerId, mat.language, reused);
          if (!(mat.lastMatch && mat.scopeKey.startsWith("match:"))) {
            combinedLayers.set(mat.scopeKey, childLayerId);
          }
        }
      } else {
        childLayerId = this.initInjection(parentLayerId, mat.language, reused);
      }

      const childData = this.layer(childLayerId);
      if (markTouched) {
        childData.flags.touched = true;
      }
      if (childData.flags.reused) {
        const same =
          reused !== null &&
          reused.matchedNodeRange.start === matchedNodeRange.start &&
          reused.matchedNodeRange.end === matchedNodeRange.end &&
          reused.layer === childLayerId;
        if (!same) childData.flags.modified = true;
      } else if (reused !== null) {
        childData.flags.reused = true;
        childData.flags.modified = true;
      }

      const pieces = intersectRanges(mat.includeChildren, mat.node, parentRanges);
      const addedInjections: Injection[] = [];
      for (const piece of pieces) {
        childData.ranges.push(piece);
        addedInjections.push({
          range: piece,
          layer: childLayerId,
          matchedNodeRange: { ...matchedNodeRange },
        });
      }
      if (insertPosition === newInjections.length) {
        newInjections.push(...addedInjections);
      } else {
        newInjections.splice(insertPosition, 0, ...addedInjections);
        childData.ranges.sort((a, b) => a.start - b.start);
      }
    }

    while (oldIdx < oldInjections.length) {
      const leftover = oldInjections[oldIdx++];
      if (leftover) {
        const leftoverLayer = this.layers.get(leftover.layer);
        if (leftoverLayer) leftoverLayer.flags.modified = true;
      }
    }

    return newInjections;
  }

  private initInjection(parent: number, language: string, reuse: Injection | null): number {
    if (reuse !== null) {
      const existing = this.layer(reuse.layer);
      existing.flags.reused = true;
      existing.ranges = [];
      return reuse.layer;
    }
    const id = this.nextLayerId++;
    this.layers.set(id, {
      language,
      managedTree: null,
      ranges: [],
      injections: [],
      flags: emptyFlags(),
      parent,
      locals: new Locals(),
      localEvents: [],
    });
    return id;
  }

  private mapInjections(layerId: number, edits: readonly Edit[]): void {
    if (edits.length === 0) return;
    const data = this.layer(layerId);
    const firstEdit = edits[0];
    if (!firstEdit) return;

    const firstRelevant = partitionPoint(
      data.injections,
      (inj) => inj.range.end < firstEdit.startIndex,
    );
    if (firstRelevant === data.injections.length) return;

    let offset = 0;
    let editIdx = 0;

    for (let i = firstRelevant; i < data.injections.length; i++) {
      const inj = data.injections[i];
      if (!inj) continue;
      const flags = this.layer(inj.layer).flags;

      while (
        editIdx < edits.length &&
        (edits[editIdx]?.oldEndIndex ?? 0) < inj.matchedNodeRange.start
      ) {
        const e = edits[editIdx++];
        if (e) offset += e.newEndIndex - e.oldEndIndex;
      }
      let mappedNodeStart = inj.matchedNodeRange.start + offset;
      const peekForNodeStart = edits[editIdx];
      if (peekForNodeStart && peekForNodeStart.startIndex <= inj.matchedNodeRange.start) {
        mappedNodeStart = peekForNodeStart.newEndIndex + offset;
      }

      while (editIdx < edits.length && (edits[editIdx]?.oldEndIndex ?? 0) < inj.range.start) {
        const e = edits[editIdx++];
        if (e) offset += e.newEndIndex - e.oldEndIndex;
      }
      if (offset !== 0) flags.moved = true;
      let mappedStart = inj.range.start + offset;

      const peekForStart = edits[editIdx];
      if (peekForStart && peekForStart.oldEndIndex <= inj.range.end) {
        editIdx++;
        if (peekForStart.startIndex < inj.range.start) {
          flags.moved = true;
          mappedStart = peekForStart.newEndIndex + offset;
        } else {
          flags.modified = true;
        }
        offset += peekForStart.newEndIndex - peekForStart.oldEndIndex;
        while (editIdx < edits.length && (edits[editIdx]?.oldEndIndex ?? 0) <= inj.range.end) {
          const e = edits[editIdx++];
          if (e) offset += e.newEndIndex - e.oldEndIndex;
        }
      }

      let mappedEnd = inj.range.end + offset;
      const peekForEnd = edits[editIdx];
      if (peekForEnd && peekForEnd.startIndex <= inj.range.end) {
        flags.modified = true;
        if (peekForEnd.startIndex < inj.range.start) {
          mappedStart = peekForEnd.newEndIndex + offset;
          mappedEnd = mappedStart;
        }
      }

      let mappedNodeEnd = inj.matchedNodeRange.end + offset;
      const peekForNodeEnd = edits[editIdx];
      if (peekForNodeEnd && peekForNodeEnd.startIndex <= inj.matchedNodeRange.end) {
        if (peekForNodeEnd.startIndex < inj.matchedNodeRange.start) {
          mappedNodeStart = peekForNodeEnd.newEndIndex + offset;
          mappedNodeEnd = mappedNodeStart;
        }
      }

      inj.range = { start: mappedStart, end: mappedEnd };
      inj.matchedNodeRange = { start: mappedNodeStart, end: mappedNodeEnd };
    }
  }
}

function injectionAt(injections: readonly Injection[], pos: number): Injection | null {
  const i = partitionPoint(injections, (inj) => inj.range.end <= pos);
  const inj = injections[i];
  if (inj && inj.range.start <= pos) return inj;
  return null;
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
