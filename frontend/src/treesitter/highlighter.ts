// Faithful port of `tree-house/src/query_iter.rs` and `tree-house/src/highlighter.rs`.
// Evaluates highlights, locals, and injections in a single forward pass over `[rangeStart, rangeEnd)`.

import type { Range as CmRange } from "@codemirror/state";
import { Decoration, type DecorationSet } from "@codemirror/view";
import type { QueryCapture } from "web-tree-sitter";
import { getLoadedLanguageBundle, type LanguageBundle } from "./languages";
import { type ScopeCursor, TREE_SITTER_MATCH_LIMIT } from "./locals";
import type { Injection, SyntaxTree } from "./syntax";
import { asTextSource, type TextInput, type TextSource } from "./textSource";
import { resolveScope, scopeToClass } from "./theme";

export interface HighlightSpan {
  readonly from: number;
  readonly to: number;
  /** Active resolved scopes from outermost (bottom of stack) to innermost (top of stack). */
  readonly scopes: readonly string[];
}

interface MatchedCapture {
  readonly patternIndex: number;
  readonly startIndex: number;
  readonly endIndex: number;
  readonly captureName: string;
  readonly scopeId: number;
}

type QueryEvent =
  | { readonly kind: "enter"; readonly injection: Injection }
  | { readonly kind: "match"; readonly capture: MatchedCapture }
  | { readonly kind: "exit"; readonly injection: Injection; readonly finished: boolean };

function eventStart(event: QueryEvent): number {
  switch (event.kind) {
    case "enter":
      return event.injection.range.start;
    case "match":
      return event.capture.startIndex;
    case "exit":
      return event.injection.range.end;
  }
}

interface ActiveLayer {
  readonly layerId: number;
  readonly language: string;
  readonly captures: QueryCapture[];
  captureIdx: number;
  peeked: MatchedCapture | null;
  readonly scopeCursor: ScopeCursor;
  readonly injections: readonly Injection[];
  injectionIdx: number;
}

/**
 * Port of `tree-house/src/query_iter.rs` `QueryIter` for highlights.
 * Streams `enter` / `match` / `exit` events across the root and injected layers in ascending order.
 */
class HighlightQueryIter {
  private readonly syntax: SyntaxTree;
  private readonly source: TextSource;
  private readonly rangeStart: number;
  private readonly rangeEnd: number;
  private readonly activeLayers = new Map<number, ActiveLayer>();
  private readonly activeInjections: Injection[] = [];
  private readonly finishedLayers = new Set<number>();
  private currentInjection: Injection;
  private currentLayerData: ActiveLayer;

  constructor(syntax: SyntaxTree, source: TextSource, rangeStart: number, rangeEnd: number) {
    this.syntax = syntax;
    this.source = source;
    this.rangeStart = rangeStart;
    this.rangeEnd = rangeEnd;

    const rootNode = syntax.tree().rootNode;
    this.currentInjection = {
      range: { start: rootNode.startIndex, end: rootNode.endIndex },
      layer: syntax.rootLayer,
      matchedNodeRange: { start: rootNode.startIndex, end: rootNode.endIndex },
    };
    this.currentLayerData = this.initLayer(this.currentInjection);
  }

  currentLayer(): number {
    return this.currentInjection.layer;
  }

  currentLanguage(): string {
    return this.syntax.layer(this.currentInjection.layer).language;
  }

  private initLayer(injection: Injection): ActiveLayer {
    const existing = this.activeLayers.get(injection.layer);
    if (existing) {
      this.activeLayers.delete(injection.layer);
      return existing;
    }

    const layer = this.syntax.layer(injection.layer);
    // Lazily parse injection layers only when highlighting actually enters them.
    const layerTree =
      layer.managedTree?.raw ?? this.syntax.ensureLayerParsed(injection.layer, this.source);

    const startPoint = Math.max(injection.range.start, this.rangeStart);
    let injectionIdx = 0;
    while (
      injectionIdx < layer.injections.length &&
      (layer.injections[injectionIdx]?.range.end ?? 0) < startPoint
    ) {
      injectionIdx++;
    }

    let captures: QueryCapture[] = [];
    if (!this.finishedLayers.has(injection.layer) && this.rangeEnd > this.rangeStart && layerTree) {
      const bundle = getLoadedLanguageBundle(layer.language);
      if (bundle?.highlightQuery) {
        captures = bundle.highlightQuery.query.captures(layerTree.rootNode, {
          startIndex: this.rangeStart,
          endIndex: this.rangeEnd,
          matchLimit: TREE_SITTER_MATCH_LIMIT,
        });
      }
    }

    return {
      layerId: injection.layer,
      language: layer.language,
      captures,
      captureIdx: 0,
      peeked: null,
      scopeCursor: layer.locals.scopeCursor(this.rangeStart),
      injections: layer.injections,
      injectionIdx,
    };
  }

  private peekCapture(layer: ActiveLayer): MatchedCapture | null {
    if (layer.peeked !== null) return layer.peeked;
    const bundle = getLoadedLanguageBundle(layer.language);
    const hlQuery = bundle?.highlightQuery ?? null;

    while (layer.captureIdx < layer.captures.length) {
      const cap = layer.captures[layer.captureIdx++];
      if (!cap) break;
      const start = cap.node.startIndex;
      const end = cap.node.endIndex;
      const scopeId = layer.scopeCursor.advance(start);

      // Port of `HighlightQueryLoader::are_predicates_satisfied` (`highlighter.rs` 548-588) for
      // `(#is-not? local)`.
      if (hlQuery?.hasLocalReference && hlQuery.nonLocalPatterns.has(cap.patternIndex)) {
        const text = this.source.slice(start, end);
        const def = layer.scopeCursor.locals.lookupReference(scopeId, text);
        if (def && start >= def.startIndex) {
          continue;
        }
      }

      layer.peeked = {
        patternIndex: cap.patternIndex,
        startIndex: start,
        endIndex: end,
        captureName: cap.name,
        scopeId,
      };
      return layer.peeked;
    }
    return null;
  }

  private consumeCapture(layer: ActiveLayer): MatchedCapture {
    const item = layer.peeked;
    if (!item) throw new Error("consumeCapture called without peeked capture");
    layer.peeked = null;
    return item;
  }

  private enterInjection(injection: Injection): void {
    const nextLayer = this.initLayer(injection);
    this.activeLayers.set(this.currentInjection.layer, this.currentLayerData);
    this.activeInjections.push(this.currentInjection);
    this.currentInjection = injection;
    this.currentLayerData = nextLayer;
  }

  private exitInjection(): { injection: Injection; finished: boolean } | null {
    const parentInjection = this.activeInjections.pop();
    if (!parentInjection) return null;
    const parentLayer = this.activeLayers.get(parentInjection.layer);
    if (!parentLayer) throw new Error("missing parent layer on exitInjection");
    this.activeLayers.delete(parentInjection.layer);

    const exitedInjection = this.currentInjection;
    const exitedLayer = this.currentLayerData;
    this.currentInjection = parentInjection;
    this.currentLayerData = parentLayer;

    const unfinished =
      exitedLayer.peeked !== null || exitedLayer.injectionIdx < exitedLayer.injections.length;
    if (unfinished) {
      this.activeLayers.set(exitedInjection.layer, exitedLayer);
      return { injection: exitedInjection, finished: false };
    }
    this.finishedLayers.add(exitedInjection.layer);
    return { injection: exitedInjection, finished: true };
  }

  next(): QueryEvent | null {
    for (;;) {
      const layer = this.currentLayerData;
      const injEnd = this.currentInjection.range.end;

      const candInj = layer.injections[layer.injectionIdx];
      const nextInj = candInj && candInj.range.start <= injEnd ? candInj : null;

      const candCap = this.peekCapture(layer);
      const nextCap = candCap && candCap.startIndex <= injEnd ? candCap : null;

      if (nextCap === null && nextInj === null) {
        const exited = this.exitInjection();
        return exited
          ? { kind: "exit", injection: exited.injection, finished: exited.finished }
          : null;
      }

      if (nextCap !== null && nextCap.startIndex === nextCap.endIndex) {
        this.consumeCapture(layer);
        continue;
      }

      if (nextCap !== null && nextInj === null) {
        return { kind: "match", capture: this.consumeCapture(layer) };
      }

      if (nextCap !== null && nextInj !== null && nextCap.startIndex < nextInj.range.end) {
        const item = this.consumeCapture(layer);
        // Emit parent captures that start at/before the injection or extend beyond it; drop parent
        // captures strictly contained inside the injection range (`query_iter.rs` 438-445).
        if (item.startIndex <= nextInj.range.start || nextInj.range.end < item.endIndex) {
          return { kind: "match", capture: item };
        }
        continue;
      }

      if (nextInj !== null) {
        layer.injectionIdx++;
        this.enterInjection(nextInj);
        return { kind: "enter", injection: nextInj };
      }
    }
  }
}

interface HighlightedNode {
  readonly end: number;
  readonly scope: string;
}

interface HighlightLayerState {
  parentHighlights: number;
  dormantHighlights: HighlightedNode[];
}

/**
 * Highlights `[rangeStart, rangeEnd)` of `input` using `tree-house`'s exact precedence,
 * stacking, locals, and injection rules, resolving captures against `knownScopes`.
 */
export function highlightRange(
  syntax: SyntaxTree,
  input: TextInput,
  rangeStart: number,
  rangeEnd: number,
  knownScopes: ReadonlySet<string>,
): HighlightSpan[] {
  const source = asTextSource(input);
  const clampedStart = Math.max(0, Math.min(rangeStart, source.length));
  const clampedEnd = Math.max(clampedStart, Math.min(rangeEnd, source.length));
  if (clampedEnd <= clampedStart) return [];

  const scopeCache = new Map<string, string | null>();
  const resolve = (capture: string): string | null => {
    const cached = scopeCache.get(capture);
    if (cached !== undefined) return cached;
    const resolved = resolveScope(capture, knownScopes);
    scopeCache.set(capture, resolved);
    return resolved;
  };

  const queryIter = new HighlightQueryIter(syntax, source, clampedStart, clampedEnd);
  let activeBundle: LanguageBundle | null = getLoadedLanguageBundle(queryIter.currentLanguage());
  let currentLayer = queryIter.currentLayer();
  const layerStates = new Map<number, HighlightLayerState>();
  const activeHighlights: HighlightedNode[] = [];
  let nextHighlightEnd = Number.MAX_SAFE_INTEGER;
  let nextQueryEvent: QueryEvent | null = null;
  let nextHighlightStart = 0;

  const advanceQueryIter = (): QueryEvent | null => {
    currentLayer = queryIter.currentLayer();
    const event = nextQueryEvent;
    nextQueryEvent = queryIter.next();
    nextHighlightStart =
      nextQueryEvent !== null ? eventStart(nextQueryEvent) : Number.MAX_SAFE_INTEGER;
    return event;
  };

  const processHighlightEnd = (pos: number): void => {
    let keep = 0;
    for (let i = activeHighlights.length - 1; i >= 0; i--) {
      if (activeHighlights[i]?.end !== pos) {
        keep = i + 1;
        break;
      }
    }
    activeHighlights.length = keep;
  };

  const currentLayerHighlights = (): HighlightedNode[] => {
    const parentStart = Math.min(
      layerStates.get(currentLayer)?.parentHighlights ?? 0,
      activeHighlights.length,
    );
    return activeHighlights.slice(parentStart);
  };

  const enterInjection = (layerId: number): void => {
    activeBundle = getLoadedLanguageBundle(syntax.layer(layerId).language);
    let state = layerStates.get(layerId);
    if (!state) {
      state = { parentHighlights: 0, dormantHighlights: [] };
      layerStates.set(layerId, state);
    }
    state.parentHighlights = activeHighlights.length;
    if (state.dormantHighlights.length > 0) {
      activeHighlights.push(...state.dormantHighlights);
      state.dormantHighlights = [];
    }
  };

  const deactivateLayer = (injection: Injection): void => {
    const state = layerStates.get(injection.layer);
    if (!state) throw new Error(`missing highlight state for layer ${injection.layer}`);
    const parentStart = Math.min(state.parentHighlights, activeHighlights.length);
    const drained = activeHighlights.splice(parentStart);
    state.dormantHighlights.push(...drained);
    processHighlightEnd(injection.range.end);
  };

  // Prime the one-event lookahead (`Highlighter::new`).
  advanceQueryIter();

  const spans: HighlightSpan[] = [];
  let pos = Math.min(nextHighlightStart, nextHighlightEnd);

  while (pos < clampedEnd) {
    if (nextHighlightEnd === pos) {
      processHighlightEnd(pos);
    }

    const prevStackSize = activeHighlights.length;
    let firstHighlight = true;
    let localRefCandidate: HighlightedNode | null = null;

    while (nextHighlightStart === pos) {
      const event = advanceQueryIter();
      if (event === null) break;

      if (event.kind === "enter") {
        enterInjection(event.injection.layer);
      } else if (event.kind === "exit") {
        const finished =
          event.finished &&
          currentLayerHighlights().every((h) => h.end <= event.injection.range.end);
        if (finished) {
          layerStates.delete(event.injection.layer);
        } else {
          deactivateLayer(event.injection);
        }
        activeBundle = getLoadedLanguageBundle(syntax.layer(currentLayer).language);
      } else {
        const cap = event.capture;
        const hlQuery = activeBundle?.highlightQuery;
        if (!hlQuery) continue;

        const isLocalRef = cap.captureName === "local.reference";

        // Discard patterns in `locals.scm` cancel a pending local reference candidate for this node.
        if (cap.patternIndex >= hlQuery.firstLocalsPattern && !isLocalRef) {
          if (localRefCandidate && localRefCandidate.end === cap.endIndex) {
            localRefCandidate = null;
          }
          continue;
        }

        if (isLocalRef) {
          const text = source.slice(cap.startIndex, cap.endIndex);
          const def = syntax.layer(currentLayer).locals.lookupReference(cap.scopeId, text);
          if (def && cap.startIndex >= def.endIndex) {
            const scope = resolve(def.scopeSuffix);
            if (scope !== null) {
              localRefCandidate = { end: cap.endIndex, scope };
            }
          }
          continue;
        }

        const resolvedScope = resolve(cap.captureName);
        const node: HighlightedNode | null =
          resolvedScope !== null ? { end: cap.endIndex, scope: resolvedScope } : null;

        if (!firstHighlight) {
          const searchStart = Math.min(prevStackSize, activeHighlights.length);
          let insertPos = -1;
          for (let i = activeHighlights.length - 1; i >= searchStart; i--) {
            if ((activeHighlights[i]?.end ?? 0) <= cap.endIndex) {
              insertPos = i;
              break;
            }
          }
          if (insertPos !== -1) {
            const existing = activeHighlights[insertPos];
            if (existing && existing.end === cap.endIndex) {
              if (node !== null) {
                activeHighlights[insertPos] = node;
              } else {
                activeHighlights.splice(insertPos, 1);
              }
            } else if (node !== null) {
              activeHighlights.splice(insertPos, 0, node);
            }
          } else if (node !== null) {
            activeHighlights.push(node);
          }
        } else if (node !== null) {
          activeHighlights.push(node);
          firstHighlight = false;
        }
      }
    }

    if (localRefCandidate !== null) {
      const searchStart = Math.min(prevStackSize, activeHighlights.length);
      let insertPos = -1;
      for (let i = activeHighlights.length - 1; i >= searchStart; i--) {
        if ((activeHighlights[i]?.end ?? 0) <= localRefCandidate.end) {
          insertPos = i;
          break;
        }
      }
      if (insertPos !== -1) {
        const existing = activeHighlights[insertPos];
        if (existing && existing.end === localRefCandidate.end) {
          activeHighlights[insertPos] = localRefCandidate;
        } else {
          activeHighlights.splice(insertPos, 0, localRefCandidate);
        }
      } else {
        activeHighlights.push(localRefCandidate);
      }
    }

    const top = activeHighlights[activeHighlights.length - 1];
    nextHighlightEnd = top ? top.end : Number.MAX_SAFE_INTEGER;

    const segStart = pos;
    pos = Math.min(nextHighlightStart, nextHighlightEnd);
    const segEnd = Math.min(pos === Number.MAX_SAFE_INTEGER ? source.length : pos, clampedEnd);

    if (activeHighlights.length > 0 && segEnd > clampedStart && segEnd > segStart) {
      const from = Math.max(segStart, clampedStart);
      const prev = spans[spans.length - 1];
      if (prev && prev.to === from && matchesActive(prev.scopes, activeHighlights)) {
        spans[spans.length - 1] = { from: prev.from, to: segEnd, scopes: prev.scopes };
      } else {
        spans.push({ from, to: segEnd, scopes: activeHighlights.map((h) => h.scope) });
      }
    }
  }

  return spans;
}

function matchesActive(scopes: readonly string[], active: readonly HighlightedNode[]): boolean {
  if (scopes.length !== active.length) return false;
  for (let i = 0; i < scopes.length; i++) {
    if (scopes[i] !== active[i]?.scope) return false;
  }
  return true;
}

const markCache = new Map<string, Decoration>();

function markForScope(scope: string): Decoration {
  let deco = markCache.get(scope);
  if (!deco) {
    deco = Decoration.mark({ class: `ts-hl ${scopeToClass(scope)}` });
    markCache.set(scope, deco);
  }
  return deco;
}

/**
 * Converts stacked highlight spans into a CodeMirror `DecorationSet`, emitting one mark per
 * contiguous span at each stack depth so outer highlights wrap inner ones in CSS cascade order.
 */
export function buildHighlightDecorations(spans: readonly HighlightSpan[]): DecorationSet {
  if (spans.length === 0) return Decoration.none;

  interface OpenRun {
    from: number;
    to: number;
    scope: string;
    depth: number;
  }

  const finished: OpenRun[] = [];
  const open: (OpenRun | null)[] = [];

  const closeFrom = (depth: number): void => {
    for (let d = open.length - 1; d >= depth; d--) {
      const run = open[d];
      if (run) finished.push(run);
    }
    open.length = depth;
  };

  for (const span of spans) {
    let common = 0;
    while (
      common < open.length &&
      common < span.scopes.length &&
      open[common]?.scope === span.scopes[common] &&
      open[common]?.to === span.from
    ) {
      common++;
    }
    closeFrom(common);
    for (let d = 0; d < common; d++) {
      const run = open[d];
      if (run) run.to = span.to;
    }
    for (let d = common; d < span.scopes.length; d++) {
      const scope = span.scopes[d];
      if (!scope) continue;
      open.push({ from: span.from, to: span.to, scope, depth: d });
    }
  }
  closeFrom(0);

  finished.sort((a, b) => a.from - b.from || a.depth - b.depth || b.to - a.to);

  const ranges: CmRange<Decoration>[] = finished.map((run) =>
    markForScope(run.scope).range(run.from, run.to),
  );
  return Decoration.set(ranges, true);
}
