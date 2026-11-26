// This Source Code Form is subject to the terms of the Mozilla Public License, v. 2.0. If a copy
// of the MPL was not distributed with this file, You can obtain one at
// https://mozilla.org/MPL/2.0/.
//
// Ported from Helix (https://github.com/helix-editor/helix): helix-core's indent.rs
// (`treesitter_indent_for_pos`, `indent_for_newline`, and the `hybrid` heuristic).

import type { Node, Query, QueryMatch } from "web-tree-sitter";
import { TREE_SITTER_MATCH_LIMIT } from "../treesitter/locals";
import type { SyntaxTree } from "../treesitter/syntax";
import { posAtVisualColumn, visualColumn } from "./movement";
import { at, Doc, firstNonWhitespace, graphemes } from "./text";

export enum IndentStyleKind {
  Tabs,
  Spaces,
}

export type IndentStyle =
  | { kind: IndentStyleKind.Tabs }
  | { kind: IndentStyleKind.Spaces; n: number };

export function indentString(style: IndentStyle): string {
  return style.kind === IndentStyleKind.Tabs
    ? "\t"
    : " ".repeat(Math.min(16, Math.max(1, style.n)));
}

export function indentWidth(style: IndentStyle, tabWidth: number): number {
  return style.kind === IndentStyleKind.Tabs ? tabWidth : style.n;
}

const MAX_INDENT = 16;

/** Guesses the indentation a document uses from how much its lines are indented by. */
export function autoDetectIndentStyle(doc: Doc): IndentStyle | null {
  const histogram = new Array<number>(MAX_INDENT + 1).fill(0);
  let prevIsTabs = false;
  let prevLeading = 0;
  outer: for (let line = 0; line < Math.min(doc.lines, 1000); line++) {
    const text = doc.line(line);
    const first = text[0];
    let isTabs: boolean;
    if (first === "\t") {
      isTabs = true;
    } else if (first === " ") {
      isTabs = false;
    } else if (first === "\n" || first === "\r") {
      continue;
    } else {
      prevIsTabs = false;
      prevLeading = 0;
      continue;
    }
    let leading = 1;
    let done = false;
    for (let i = 1; i < text.length; i++) {
      const c = text[i];
      if (c === "\t" && isTabs && !done) {
        leading++;
      } else if (c === " " && !isTabs && !done) {
        leading++;
      } else if (c === "\n" || c === "\r") {
        continue outer;
      } else if (c === " " || c === "\t") {
        done = true;
      } else {
        break;
      }
      if (leading > 256) continue outer;
    }
    if ((prevIsTabs === isTabs || prevLeading === 0) && prevLeading < leading) {
      const bucket = isTabs ? 0 : leading - prevLeading;
      if (bucket <= MAX_INDENT) histogram[bucket] = at(histogram, bucket) + 1;
    }
    prevIsTabs = isTabs;
    prevLeading = leading;
  }
  histogram[0] = at(histogram, 0) * 2;
  // Single spaces are often used in comments, and rarely as indentation.
  if (at(histogram, 1) > 1) histogram[1] = Math.floor(at(histogram, 1) / 2);

  let indent = 0;
  for (let i = 1; i < histogram.length; i++)
    if (at(histogram, i) > at(histogram, indent)) indent = i;
  const freq = at(histogram, indent);
  const freq2 = Math.max(...histogram.filter((_, i) => i !== indent));
  if (freq >= 1 && freq2 / freq < 0.66) {
    return indent === 0
      ? { kind: IndentStyleKind.Tabs }
      : { kind: IndentStyleKind.Spaces, n: indent };
  }
  return null;
}

export type IndentationHeuristic = "simple" | "tree-sitter" | "hybrid";

/** Indent level of `line`, counted in whole `width`-column steps. */
export function indentLevelForLine(
  doc: Doc,
  line: number,
  tabWidth: number,
  width: number,
): number {
  let len = 0;
  for (const ch of doc.line(line)) {
    if (ch === "\t") {
      len += tabWidth - (len % tabWidth);
    } else if (ch === " ") {
      len++;
    } else {
      break;
    }
  }
  return Math.floor(len / width);
}

function whitespaceWithSameWidth(text: string): string {
  let out = "";
  for (const g of graphemes(text)) {
    out += g === "\t" ? "\t" : " ";
  }
  return out;
}

function addIndentLevel(
  baseIndent: string,
  addedIndentLevel: number,
  indentStyle: IndentStyle,
  tabWidth: number,
): string {
  if (addedIndentLevel >= 0) {
    return baseIndent + indentString(indentStyle).repeat(addedIndentLevel);
  }
  const baseDoc = Doc.of(baseIndent);
  const baseWidth = visualColumn(baseDoc, baseDoc.length, tabWidth);
  const reduction = -addedIndentLevel * indentWidth(indentStyle, tabWidth);
  const targetWidth = Math.max(0, baseWidth - reduction);
  const endIdx = posAtVisualColumn(baseDoc, 0, targetWidth, tabWidth);
  return baseIndent.slice(0, endIdx);
}

interface IndentQueryPredicates {
  notKindEq: [string, string][];
  sameLine: [string, string, boolean] | null;
  oneLine: [string, boolean] | null;
}

export interface CompiledIndentQuery {
  readonly query: Query;
  readonly headerPatterns: ReadonlySet<number>;
  readonly predicates: ReadonlyMap<number, IndentQueryPredicates>;
  readonly hasOpaqueCapture: boolean;
}

const compiledCache = new WeakMap<Query, CompiledIndentQuery>();

/** Parses Helix's `indents.scm` properties (`#set! scope "header"`) and custom predicates. */
export function compileIndentQuery(query: Query): CompiledIndentQuery {
  const cached = compiledCache.get(query);
  if (cached !== undefined) return cached;

  const headerPatterns = new Set<number>();
  const predicates = new Map<number, IndentQueryPredicates>();

  const getPreds = (pattern: number): IndentQueryPredicates => {
    let entry = predicates.get(pattern);
    if (entry === undefined) {
      entry = { notKindEq: [], sameLine: null, oneLine: null };
      predicates.set(pattern, entry);
    }
    return entry;
  };

  const patternCount = query.patternCount();
  for (let p = 0; p < patternCount; p++) {
    const props = query.setProperties[p];
    if (props && Object.hasOwn(props, "scope")) {
      const val = props.scope;
      if (val === "header") {
        headerPatterns.add(p);
      } else if (val === null || val === undefined) {
        throw new Error("missing scope value (#set! scope ...) in indents.scm");
      } else {
        throw new Error(`unknown scope (#set! scope ${JSON.stringify(val)}) in indents.scm`);
      }
    }

    const patternPreds = query.predicates[p];
    if (!patternPreds) continue;
    for (const pred of patternPreds) {
      const { operator, operands } = pred;
      if (operator === "not-kind-eq?") {
        const cap = operands[0];
        const kind = operands[1];
        if (operands.length !== 2 || cap?.type !== "capture" || kind?.type !== "string") {
          throw new Error("invalid #not-kind-eq? predicate in indents.scm");
        }
        getPreds(p).notKindEq.push([cap.name, kind.value]);
      } else if (operator === "same-line?" || operator === "not-same-line?") {
        const cap1 = operands[0];
        const cap2 = operands[1];
        if (operands.length !== 2 || cap1?.type !== "capture" || cap2?.type !== "capture") {
          throw new Error(`invalid #${operator} predicate in indents.scm`);
        }
        getPreds(p).sameLine = [cap1.name, cap2.name, operator === "not-same-line?"];
      } else if (operator === "one-line?" || operator === "not-one-line?") {
        const cap = operands[0];
        if (operands.length !== 1 || cap?.type !== "capture") {
          throw new Error(`invalid #${operator} predicate in indents.scm`);
        }
        getPreds(p).oneLine = [cap.name, operator === "not-one-line?"];
      } else {
        throw new Error(`unknown predicate #${operator} in indents.scm`);
      }
    }
  }

  const compiled: CompiledIndentQuery = {
    query,
    headerPatterns,
    predicates,
    hasOpaqueCapture: query.captureIndexForName("opaque") !== -1,
  };
  compiledCache.set(query, compiled);
  return compiled;
}

function firstCaptureNode(match: QueryMatch, name: string): Node | null {
  for (const cap of match.captures) {
    if (cap.name === name) return cap.node;
  }
  return null;
}

function getNodeStartLine(doc: Doc, node: Node, newLinePos: number | null): number {
  let line = doc.lineOf(node.startIndex);
  if (newLinePos !== null && node.startIndex >= newLinePos) {
    line++;
  }
  return line;
}

function getNodeEndLine(doc: Doc, node: Node, newLinePos: number | null): number {
  let line = doc.lineOf(node.endIndex);
  if (newLinePos !== null && node.endIndex > newLinePos) {
    line++;
  }
  return line;
}

function predicatesSatisfied(
  preds: IndentQueryPredicates,
  match: QueryMatch,
  doc: Doc,
  newLinePos: number | null,
): boolean {
  for (const [captureName, notExpectedKind] of preds.notKindEq) {
    const node = firstCaptureNode(match, captureName);
    if (node !== null && node.type === notExpectedKind) {
      return false;
    }
  }

  if (preds.sameLine !== null) {
    const [cap1, cap2, negated] = preds.sameLine;
    const n1 = firstCaptureNode(match, cap1);
    const n2 = firstCaptureNode(match, cap2);
    if (n1 === null || n2 === null) return false;
    const same = getNodeStartLine(doc, n1, newLinePos) === getNodeStartLine(doc, n2, newLinePos);
    if (same === negated) return false;
  }

  if (preds.oneLine !== null) {
    const [cap, negated] = preds.oneLine;
    const node = firstCaptureNode(match, cap);
    if (node === null) return false;
    const one = getNodeStartLine(doc, node, newLinePos) === getNodeEndLine(doc, node, newLinePos);
    if (one === negated) return false;
  }

  return true;
}

export class Indentation {
  constructor(
    public indent = 0,
    public indentAlways = 0,
    public outdent = 0,
    public outdentAlways = 0,
    public align: string | null = null,
  ) {}

  netIndent(): number {
    return this.indent + this.indentAlways - (this.outdent + this.outdentAlways);
  }

  relativeIndent(
    otherComputed: Indentation,
    otherLeadingWhitespace: string,
    indentStyle: IndentStyle,
    tabWidth: number,
  ): string | null {
    if (this.align !== otherComputed.align) return null;
    const indentDiff = this.netIndent() - otherComputed.netIndent();
    return addIndentLevel(otherLeadingWhitespace, indentDiff, indentStyle, tabWidth);
  }

  toString(indentStyle: IndentStyle, tabWidth: number): string {
    const base = this.align === null ? "" : whitespaceWithSameWidth(this.align);
    return addIndentLevel(base, this.netIndent(), indentStyle, tabWidth);
  }
}

type IndentCaptureType =
  | { readonly kind: "indent" }
  | { readonly kind: "indent.always" }
  | { readonly kind: "outdent" }
  | { readonly kind: "outdent.always" }
  | { readonly kind: "align"; align: string };

interface IndentCapture {
  readonly captureType: IndentCaptureType;
  readonly header: boolean;
}

type ExtendCapture = "extend" | "prevent-once";

interface IndentQueryResult {
  readonly indentCaptures: Map<number, IndentCapture[]>;
  readonly extendCaptures: Map<number, ExtendCapture[]>;
  readonly opaqueRanges: { readonly start: number; readonly end: number }[];
}

function queryIndents(
  compiled: CompiledIndentQuery,
  root: Node,
  doc: Doc,
  startIndex: number,
  endIndex: number,
  newLinePos: number | null,
): IndentQueryResult {
  const indentCaptures = new Map<number, IndentCapture[]>();
  const extendCaptures = new Map<number, ExtendCapture[]>();
  const opaqueRanges: { readonly start: number; readonly end: number }[] = [];

  const matches = compiled.query.matches(root, {
    startIndex,
    endIndex,
    matchLimit: TREE_SITTER_MATCH_LIMIT,
  });

  for (const m of matches) {
    const preds = compiled.predicates.get(m.patternIndex);
    if (preds !== undefined && !predicatesSatisfied(preds, m, doc, newLinePos)) {
      continue;
    }

    const addedIndentCaptures: [number, IndentCapture][] = [];
    let anchor: Node | null = null;
    const header = compiled.headerPatterns.has(m.patternIndex);

    for (const cap of m.captures) {
      const nodeId = cap.node.id;
      let captureType: IndentCaptureType;
      switch (cap.name) {
        case "indent":
          captureType = { kind: "indent" };
          break;
        case "indent.always":
          captureType = { kind: "indent.always" };
          break;
        case "outdent":
          captureType = { kind: "outdent" };
          break;
        case "outdent.always":
          captureType = { kind: "outdent.always" };
          break;
        case "align":
          captureType = { kind: "align", align: "" };
          break;
        case "anchor":
          if (anchor === null) anchor = cap.node;
          continue;
        case "extend": {
          const list = extendCaptures.get(nodeId) ?? [];
          list.push("extend");
          extendCaptures.set(nodeId, list);
          continue;
        }
        case "extend.prevent-once": {
          const list = extendCaptures.get(nodeId) ?? [];
          list.push("prevent-once");
          extendCaptures.set(nodeId, list);
          continue;
        }
        case "opaque":
          opaqueRanges.push({ start: cap.node.startIndex, end: cap.node.endIndex });
          continue;
        default:
          continue;
      }
      addedIndentCaptures.push([nodeId, { captureType, header }]);
    }

    for (const [nodeId, capture] of addedIndentCaptures) {
      if (capture.captureType.kind === "align") {
        if (anchor === null) continue;
        const line = doc.lineOf(anchor.startIndex);
        const lineStart = doc.lineStart(line);
        capture.captureType.align = doc.slice(lineStart, anchor.startIndex);
      }
      const list = indentCaptures.get(nodeId) ?? [];
      list.push(capture);
      indentCaptures.set(nodeId, list);
    }
  }

  return { indentCaptures, extendCaptures, opaqueRanges };
}

function isExtra(node: Node): boolean {
  return node.isExtra && node.type !== "ERROR";
}

function extendNodes(
  node: Node,
  initialPreceding: Node,
  extendCaptures: ReadonlyMap<number, readonly ExtendCapture[]>,
  doc: Doc,
  line: number,
  tabWidth: number,
  width: number,
): { node: Node; extended: boolean } {
  let stopExtend = false;
  // Ancestors may also span trailing comments.
  const contentEndLine = doc.lineOf(initialPreceding.endIndex);
  let deepestPreceding: Node = initialPreceding;

  while (deepestPreceding.id !== node.id) {
    let extendNode = false;
    let nodeCaptured = false;
    const captures = extendCaptures.get(deepestPreceding.id);
    if (captures !== undefined) {
      for (const capture of captures) {
        if (capture === "prevent-once") {
          stopExtend = true;
        } else {
          nodeCaptured = true;
          if (contentEndLine === line) {
            extendNode = true;
          } else {
            const cursorIndent = indentLevelForLine(doc, line, tabWidth, width);
            const nodeIndent = indentLevelForLine(
              doc,
              doc.lineOf(deepestPreceding.startIndex),
              tabWidth,
              width,
            );
            if (cursorIndent > nodeIndent) {
              extendNode = true;
            }
          }
        }
      }
    }

    if (nodeCaptured && stopExtend) {
      stopExtend = false;
    } else if (extendNode && !stopExtend) {
      return { node: deepestPreceding, extended: true };
    }

    const parent = deepestPreceding.parent;
    if (parent === null) return { node, extended: false };
    deepestPreceding = parent;
  }

  return { node, extended: false };
}

/**
 * Returns the last child of `node` before `pos`, skipping extra nodes. If the parser closed both
 * `node` and the child before it with MISSING tokens, that child is the innermost open node.
 */
function lastChild(node: Node, pos: number): Node | null {
  let prev: Node | null = null;
  let last: Node | null = null;
  for (const child of node.children) {
    if (child.endIndex <= pos && !isExtra(child)) {
      prev = last;
      last = child;
    }
  }
  if (last === null) return null;
  if (prev !== null && last.isMissing && prev.endIndex === last.startIndex && isUnclosed(prev)) {
    return prev;
  }
  return last;
}

/** Whether `node` is an ERROR or its last non-extra token is MISSING. */
function isUnclosed(initial: Node): boolean {
  let node: Node = initial;
  for (;;) {
    if (node.isMissing || node.type === "ERROR") return true;
    let last: Node | null = null;
    for (const child of node.children) {
      if (!isExtra(child)) last = child;
    }
    if (last === null) return false;
    node = last;
  }
}

function candidateBodyForNewLine(deepestPreceding: Node, pos: number): Node | null {
  let node = deepestPreceding;
  for (;;) {
    const parent = node.parent;
    if (parent === null) return null;
    if (node.endIndex > pos) return null;

    const cursor = parent.walk();
    try {
      if (cursor.gotoFirstChild()) {
        for (;;) {
          if (cursor.currentNode.id === node.id) {
            if (cursor.gotoNextSibling()) {
              // Step over a trailing comment on the header line.
              while (
                isExtra(cursor.currentNode) &&
                cursor.currentNode.endIndex <= pos &&
                cursor.gotoNextSibling()
              ) {}
              const child = cursor.currentNode;
              if (child.startIndex >= pos) {
                return child;
              }
            }
            break;
          }
          if (!cursor.gotoNextSibling()) break;
        }
      }
    } finally {
      cursor.delete();
    }
    node = parent;
  }
}

function initIndentQuery(
  compiled: CompiledIndentQuery,
  root: Node,
  doc: Doc,
  tabWidth: number,
  width: number,
  line: number,
  pos: number,
  newLinePos: number | null,
): {
  node: Node;
  captures: ReadonlyMap<number, readonly IndentCapture[]>;
  opaqueRanges: readonly { readonly start: number; readonly end: number }[];
  openEnded: boolean;
} | null {
  let node = root.descendantForIndex(pos, pos);
  if (node === null) return null;

  let deepestPreceding = lastChild(node, pos);
  while (deepestPreceding !== null) {
    const last = lastChild(deepestPreceding, pos);
    if (last === null) break;
    deepestPreceding = last;
  }

  const candidateBody =
    newLinePos !== null && deepestPreceding !== null
      ? candidateBodyForNewLine(deepestPreceding, pos)
      : null;
  const upper = candidateBody !== null ? candidateBody.endIndex : pos + 1;
  const lower = deepestPreceding !== null ? Math.max(0, deepestPreceding.endIndex - 1) : pos;

  const queryResult = queryIndents(compiled, root, doc, lower, upper, newLinePos);

  let descended = false;
  if (candidateBody !== null) {
    const defs = queryResult.indentCaptures.get(candidateBody.id);
    if (defs?.some((c) => c.header)) {
      node = candidateBody;
      descended = true;
    }
  }

  // When the parser closes an unfinished node with a zero-width MISSING token,
  // as it does for `struct S {`, the node is still open.
  if (
    deepestPreceding !== null &&
    !descended &&
    newLinePos !== null &&
    deepestPreceding.isMissing
  ) {
    let open = deepestPreceding.parent;
    while (open !== null && open.startIndex === deepestPreceding.startIndex) {
      const parent = open.parent;
      if (parent === null) break;
      open = parent;
    }
    if (open !== null) {
      return {
        node: open,
        captures: queryResult.indentCaptures,
        opaqueRanges: queryResult.opaqueRanges,
        openEnded: true,
      };
    }
  }

  // With auto-pairs off, a typed `{`, `(` or `[` has no closing bracket yet and
  // ends up in an ERROR node. Indent the next line as if it were closed.
  if (
    deepestPreceding !== null &&
    !descended &&
    newLinePos !== null &&
    (deepestPreceding.type === "{" ||
      deepestPreceding.type === "(" ||
      deepestPreceding.type === "[") &&
    doc.lineOf(deepestPreceding.startIndex) === line &&
    deepestPreceding.parent?.type === "ERROR"
  ) {
    const captures = queryResult.indentCaptures;
    const list = captures.get(deepestPreceding.id) ?? [];
    list.push({ captureType: { kind: "indent" }, header: false });
    captures.set(deepestPreceding.id, list);
    return {
      node: deepestPreceding,
      captures,
      opaqueRanges: queryResult.opaqueRanges,
      openEnded: true,
    };
  }

  let extended = false;
  if (deepestPreceding !== null && !descended) {
    const res = extendNodes(
      node,
      deepestPreceding,
      queryResult.extendCaptures,
      doc,
      line,
      tabWidth,
      width,
    );
    node = res.node;
    extended = res.extended;
  }

  let firstChild: Node | null = null;
  let lastNonExtra: Node | null = null;
  for (const child of node.children) {
    if (isExtra(child)) continue;
    if (firstChild === null) firstChild = child;
    else lastNonExtra = child;
  }
  const delimited =
    firstChild !== null && lastNonExtra !== null && !firstChild.isNamed && !lastNonExtra.isNamed;
  const openEnded = extended && !delimited;

  return {
    node,
    captures: queryResult.indentCaptures,
    opaqueRanges: queryResult.opaqueRanges,
    openEnded,
  };
}

function opaqueHit(start: number, end: number, pos: number, doc: Doc): boolean {
  return start <= pos && pos < end && doc.lineOf(start) < doc.lineOf(pos);
}

function containmentAccounting(
  compiled: CompiledIndentQuery,
  root: Node,
  doc: Doc,
  tabWidth: number,
  width: number,
  line: number,
  pos: number,
  newLine: boolean,
): { indentation: Indentation; opaque: boolean } | null {
  const newLinePos = newLine ? pos : null;
  const init = initIndentQuery(compiled, root, doc, tabWidth, width, line, pos, newLinePos);
  if (init === null) return null;

  if (init.opaqueRanges.some((r) => opaqueHit(r.start, r.end, pos, doc))) {
    return { indentation: new Indentation(), opaque: true };
  }

  const targetLine = line + (newLine ? 1 : 0);
  let indentLevels = 0;
  let indentAlways = 0;
  let outdent = 0;
  let outdentAlways = 0;
  let align: string | null = null;
  const countedStartLines: number[] = [];
  let insideAlign: { alignStart: number; inner: number; innerAlways: number } | null = null;

  let node: Node | null = init.node;
  while (node !== null) {
    const defs = init.captures.get(node.id);
    if (defs !== undefined) {
      let hasIndent = false;
      let hasIndentAlways = false;
      let hasOutdent = false;
      let hasOutdentAlways = false;
      let headerScoped = false;
      let nodeAlign: string | null = null;

      for (const def of defs) {
        switch (def.captureType.kind) {
          case "indent":
            hasIndent = true;
            headerScoped ||= def.header;
            break;
          case "indent.always":
            hasIndentAlways = true;
            headerScoped ||= def.header;
            break;
          case "outdent":
            hasOutdent = true;
            break;
          case "outdent.always":
            hasOutdentAlways = true;
            break;
          case "align":
            nodeAlign = def.captureType.align;
            break;
        }
      }

      const nodeStart = getNodeStartLine(doc, node, newLinePos);
      let end = getNodeEndLine(doc, node, newLinePos);
      if (init.openEnded && newLine) {
        end = Math.max(end, targetLine);
      }
      const start =
        headerScoped && node.parent !== null
          ? getNodeStartLine(doc, node.parent, newLinePos)
          : nodeStart;
      const contains = start < targetLine && targetLine <= end;
      const opensTarget = nodeStart === targetLine;

      // Innermost containing alignment wins (first seen on the upward walk).
      if (nodeAlign !== null && contains && align === null) {
        align = nodeAlign;
        insideAlign = {
          alignStart: start,
          inner: countedStartLines.length,
          innerAlways: indentAlways,
        };
      }

      if ((hasIndent || hasIndentAlways) && (hasOutdent || hasOutdentAlways)) {
        // Indent + outdent on the same node cancel each other.
      } else {
        if (hasIndent && contains && !countedStartLines.includes(start)) {
          countedStartLines.push(start);
          indentLevels++;
        }
        if (hasIndentAlways && contains) {
          indentAlways++;
        }
        if (hasOutdent && opensTarget) {
          outdent++;
        }
        if (hasOutdentAlways && opensTarget) {
          outdentAlways++;
        }
      }
    }
    node = node.parent;
  }

  // Only scopes inside the aligned node add to the anchor column, except one
  // opening on the node's first line.
  if (insideAlign !== null) {
    indentLevels = countedStartLines
      .slice(0, insideAlign.inner)
      .filter((s) => s !== insideAlign.alignStart).length;
    indentAlways = insideAlign.innerAlways;
  }

  return {
    indentation: new Indentation(indentLevels, indentAlways, outdent, outdentAlways, align),
    opaque: false,
  };
}

function injectionBaseLevel(
  syntax: SyntaxTree,
  doc: Doc,
  pos: number,
  tabWidth: number,
  width: number,
): number {
  const layer = syntax.layerForRange(pos, pos);
  const inLayer = (lineIdx: number): boolean => {
    const fnw = firstNonWhitespace(doc, lineIdx);
    if (fnw === null) return false;
    const p = doc.lineStart(lineIdx) + fnw;
    return syntax.layerForRange(p, p) === layer;
  };

  const bl = doc.lineOf(pos);
  let first: number;
  if (inLayer(bl)) {
    first = bl;
    for (let prev = bl - 1; prev >= 0; prev--) {
      if (inLayer(prev)) {
        first = prev;
      } else if (firstNonWhitespace(doc, prev) !== null) {
        break;
      }
    }
  } else {
    first = Math.min(bl + 1, doc.lines - 1);
    while (first + 1 < doc.lines && !inLayer(first)) {
      first++;
    }
  }
  return indentLevelForLine(doc, first, tabWidth, width);
}

/** Computes tree-sitter indentation for `(line, pos)` using `query` and `syntax`. */
export function treesitterIndentForPos(
  compiled: CompiledIndentQuery,
  syntax: SyntaxTree,
  tabWidth: number,
  width: number,
  doc: Doc,
  line: number,
  rawPos: number,
  newLine: boolean,
): Indentation | null {
  const pos = newLine && doc.str[rawPos] === "\r" ? rawPos + 1 : rawPos;
  const layer = syntax.layerForRange(pos, pos);
  const injectedRaw =
    layer !== syntax.rootLayer && syntax.layer(layer).language !== syntax.rootLanguage()
      ? syntax.queryForLayer(layer, "indents")
      : null;
  const activeQuery = injectedRaw !== null ? compileIndentQuery(injectedRaw) : compiled;
  const tree = injectedRaw !== null ? syntax.treeForRange(pos, pos, doc.str) : syntax.tree();

  const accounted = containmentAccounting(
    activeQuery,
    tree.rootNode,
    doc,
    tabWidth,
    width,
    line,
    pos,
    newLine,
  );
  if (accounted === null) return null;

  if (accounted.opaque) {
    const lineText = doc.line(line);
    const first = firstNonWhitespace(doc, line) ?? lineText.length;
    return new Indentation(0, 0, 0, 0, lineText.slice(0, first));
  }

  if (injectedRaw !== null) {
    accounted.indentation.indent += injectionBaseLevel(syntax, doc, pos, tabWidth, width);
  }
  return accounted.indentation;
}

/**
 * Computes the indentation string for a new line, using `indents.scm` with Helix's `hybrid`
 * heuristic when available, or falling back to copying whole indent levels from `currentLine`.
 */
export function indentForNewline(
  syntax: SyntaxTree | null,
  indentStyle: IndentStyle,
  tabWidth: number,
  doc: Doc,
  lineBefore: number,
  lineBeforeEndPos: number,
  currentLine: number,
  heuristic: IndentationHeuristic = "hybrid",
  indentQueryOverride?: CompiledIndentQuery | null,
): string {
  const width = indentWidth(indentStyle, tabWidth);
  if (heuristic !== "simple" && syntax !== null) {
    const compiled =
      indentQueryOverride !== undefined
        ? indentQueryOverride
        : (() => {
            const raw = syntax.queryForLayer(syntax.rootLayer, "indents");
            return raw !== null ? compileIndentQuery(raw) : null;
          })();

    if (compiled !== null) {
      const indent = treesitterIndentForPos(
        compiled,
        syntax,
        tabWidth,
        width,
        doc,
        lineBefore,
        lineBeforeEndPos,
        true,
      );
      if (indent !== null) {
        if (heuristic === "hybrid") {
          const MAX_ATTEMPTS = 4;
          let numAttempts = 0;
          for (let lineIdx = lineBefore; lineIdx >= 0; lineIdx--) {
            const fnw = firstNonWhitespace(doc, lineIdx);
            if (fnw === null) continue;
            const computed = treesitterIndentForPos(
              compiled,
              syntax,
              tabWidth,
              width,
              doc,
              lineIdx,
              doc.lineStart(lineIdx) + fnw,
              false,
            );
            if (computed !== null) {
              const leadingWs = doc.line(lineIdx).slice(0, fnw);
              const relative = indent.relativeIndent(computed, leadingWs, indentStyle, tabWidth);
              if (relative !== null) return relative;
            }
            numAttempts++;
            if (numAttempts === MAX_ATTEMPTS) break;
          }
        }
        return indent.toString(indentStyle, tabWidth);
      }
    }
  }

  const level = indentLevelForLine(doc, currentLine, tabWidth, width);
  return indentString(indentStyle).repeat(level);
}
