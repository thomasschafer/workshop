import { indentService, indentUnit } from "@codemirror/language";
import { EditorState, type Extension, StateEffect, StateField, type Text } from "@codemirror/state";
import {
  Decoration,
  type DecorationSet,
  type EditorView,
  type PluginValue,
  ViewPlugin,
  type ViewUpdate,
} from "@codemirror/view";
import type { Query, Tree } from "web-tree-sitter";
import {
  autoDetectIndentStyle,
  compileIndentQuery,
  indentForNewline,
  indentString,
  indentWidth,
  treesitterIndentForPos,
} from "../helix/indent";
import { LANGUAGES as HELIX_LANGUAGES, PLAIN_TEXT } from "../helix/languages";
import { Doc, firstNonWhitespace } from "../helix/text";
import { buildHighlightDecorations, highlightRange } from "./highlighter";
import {
  getLoadedLanguageBundle,
  hasTreeSitterMode,
  type LanguageBundle,
  loadLanguageBundle,
  type QueryKind,
} from "./languages";
import { changeSetToEdits, type SyntaxSnapshot, SyntaxTree } from "./syntax";
import { textSourceFromDoc } from "./textSource";
import { activeSyntaxScopeSet, onSyntaxThemeChange } from "./theme";

export type { HighlightSpan } from "./highlighter";
export { buildHighlightDecorations, highlightRange } from "./highlighter";
export type { LanguageBundle, QueryKind, WasmBytesLoader } from "./languages";
export {
  getLoadedLanguageBundle,
  hasTreeSitterMode,
  loadLanguageBundle,
  onLanguageBundleLoaded,
  registeredTreeSitterModes,
  setWasmBytesLoader,
} from "./languages";
export { TREE_SITTER_MATCH_LIMIT } from "./locals";
export type { TreeStats } from "./managedTree";
export { getTreeStats } from "./managedTree";
export type { SyntaxSnapshot } from "./syntax";
export { changeSetToEdits, SyntaxTree } from "./syntax";
export type { CapturedNode } from "./textObject";
export { captureCovers, captureNodes, captureNodesAny } from "./textObject";
export {
  activeSyntaxScopeSet,
  buildHelixSyntaxCss,
  onSyntaxThemeChange,
  resolveScope,
  scopeToClass,
  setActiveSyntaxThemes,
  WORKSHOP_SYNTAX_SCOPES,
} from "./theme";
export { SyntaxTreeCursor } from "./treeCursor";

/** Extra lines highlighted above and below the viewport to keep scrolling smooth. */
const VIEWPORT_MARGIN_LINES = 20;

/**
 * Number of recent EditorState snapshots whose WASM `SyntaxTree`s are kept hot per editor:
 * current state + immediately previous `tr.startState`. Older snapshots are evicted deterministically
 * (freeing their unshared WASM trees immediately) and transparently re-parse from their immutable
 * CodeMirror `Text` if ever accessed later.
 */
const SNAPSHOT_POOL_CAPACITY = 2;

const syntaxLoadedEffect = StateEffect.define<{
  readonly mode: string;
  readonly bundle: LanguageBundle;
  readonly pool: SnapshotPool;
}>();

const themeChangedEffect = StateEffect.define<null>();

interface PoolEntry {
  syntax: SyntaxTree | null;
}

/**
 * Per-editor bounded pool that guarantees deterministic freeing of superseded WASM `SyntaxTree`s
 * while remaining sound if an older `EditorState` is retained and queried later.
 */
class SnapshotPool {
  private readonly entries: PoolEntry[] = [];

  register(syntax: SyntaxTree): PoolEntry {
    const entry: PoolEntry = { syntax };
    this.entries.push(entry);
    while (this.entries.length > SNAPSHOT_POOL_CAPACITY) {
      const evicted = this.entries.shift();
      if (evicted?.syntax) {
        evicted.syntax.delete();
        evicted.syntax = null;
      }
    }
    return entry;
  }

  clear(): void {
    while (this.entries.length > 0) {
      const entry = this.entries.shift();
      if (entry?.syntax) {
        entry.syntax.delete();
        entry.syntax = null;
      }
    }
  }
}

class PooledSyntaxSnapshot implements SyntaxSnapshot {
  readonly mode: string;
  readonly bundle: LanguageBundle;
  readonly pool: SnapshotPool;
  private readonly doc: Text;
  private readonly entry: PoolEntry;
  /** Lazily re-materialised only if an already-evicted old `EditorState` is read later. */
  private fallbackSyntax: SyntaxTree | null = null;

  constructor(
    mode: string,
    bundle: LanguageBundle,
    doc: Text,
    pool: SnapshotPool,
    entry: PoolEntry,
  ) {
    this.mode = mode;
    this.bundle = bundle;
    this.doc = doc;
    this.pool = pool;
    this.entry = entry;
  }

  get syntax(): SyntaxTree {
    if (this.entry.syntax !== null) return this.entry.syntax;
    if (this.fallbackSyntax === null) {
      this.fallbackSyntax = SyntaxTree.parse(textSourceFromDoc(this.doc), this.mode);
    }
    return this.fallbackSyntax;
  }

  get tree(): Tree {
    return this.syntax.tree();
  }

  query(kind: QueryKind): Query | null {
    return this.bundle.query(kind);
  }
}

function createPooledSnapshot(
  mode: string,
  bundle: LanguageBundle,
  doc: Text,
  pool: SnapshotPool,
  syntax: SyntaxTree,
): PooledSyntaxSnapshot {
  const entry = pool.register(syntax);
  return new PooledSyntaxSnapshot(mode, bundle, doc, pool, entry);
}

/**
 * Synchronous access to the current document's tree-sitter syntax tree and compiled queries, or
 * `null` while the grammar is still loading (or for modes not using tree-sitter).
 */
export const syntaxTreeField = StateField.define<SyntaxSnapshot | null>({
  create: () => null,
  update(prev, tr) {
    for (const effect of tr.effects) {
      if (effect.is(syntaxLoadedEffect)) {
        const { mode, bundle, pool } = effect.value;
        const syntax = SyntaxTree.parse(textSourceFromDoc(tr.newDoc), mode);
        return createPooledSnapshot(mode, bundle, tr.newDoc, pool, syntax);
      }
    }
    if (prev === null || !tr.docChanged) return prev;
    const bundle = getLoadedLanguageBundle(prev.mode);
    if (!bundle) return null;
    const edits = changeSetToEdits(tr.startState.doc, tr.changes);
    const nextSyntax = prev.syntax.cloneForEdit();
    nextSyntax.update(textSourceFromDoc(tr.newDoc), edits);
    const pool = prev instanceof PooledSyntaxSnapshot ? prev.pool : new SnapshotPool();
    return createPooledSnapshot(prev.mode, bundle, tr.newDoc, pool, nextSyntax);
  },
});

/** Reads the current syntax tree snapshot synchronously from an `EditorState`, or `null`. */
export function getSyntaxTree(state: EditorState): SyntaxSnapshot | null {
  return state.field(syntaxTreeField, false) ?? null;
}

function visibleRangeWithMargin(view: EditorView): { from: number; to: number } {
  const doc = view.state.doc;
  if (doc.length === 0) return { from: 0, to: 0 };
  const vp = view.viewport;
  const startLine = Math.max(1, doc.lineAt(vp.from).number - VIEWPORT_MARGIN_LINES);
  const endLine = Math.min(doc.lines, doc.lineAt(vp.to).number + VIEWPORT_MARGIN_LINES);
  return {
    from: doc.line(startLine).from,
    to: doc.line(endLine).to,
  };
}

function computeDecorations(view: EditorView): DecorationSet {
  const snapshot = getSyntaxTree(view.state);
  if (!snapshot) return Decoration.none;
  const { from, to } = visibleRangeWithMargin(view);
  if (to <= from) return Decoration.none;
  const spans = highlightRange(
    snapshot.syntax,
    textSourceFromDoc(view.state.doc),
    from,
    to,
    activeSyntaxScopeSet(),
  );
  return buildHighlightDecorations(spans);
}

function indentColumns(text: string, tabWidth: number): number {
  let cols = 0;
  for (let i = 0; i < text.length; i++) {
    cols += text[i] === "\t" ? tabWidth - (cols % tabWidth) : 1;
  }
  return cols;
}

/**
 * Provides CodeMirror's `indentUnit`, `indentService`, `indentOnInput`, and `commentTokens`
 * from Helix's language config and ported `indents.scm` engine, so non-Helix keybindings
 * (Enter, closing brackets, comment toggle) and LSP formatting agree with Helix.
 */
function languageMetadata(mode: string): Extension {
  const helixLang = HELIX_LANGUAGES[mode] ?? PLAIN_TEXT;
  const data: {
    commentTokens?: { line?: string; block?: { open: string; close: string } };
    indentOnInput?: RegExp;
  } = {
    indentOnInput: /^\s*[}\])]$/,
  };
  const commentTokens: { line?: string; block?: { open: string; close: string } } = {};
  if (helixLang.lineComments[0]) commentTokens.line = helixLang.lineComments[0];
  if (helixLang.blockComments[0]) commentTokens.block = helixLang.blockComments[0];
  if (commentTokens.line || commentTokens.block) data.commentTokens = commentTokens;

  const helixIndentService = indentService.of((context, pos) => {
    const snapshot = getSyntaxTree(context.state);
    const doc = new Doc(context.state.doc);
    const indentStyle = autoDetectIndentStyle(doc) ?? helixLang.indent;
    const tabWidth = helixLang.tabWidth;
    if (context.simulatedBreak !== null) {
      const breakPos = context.simulatedBreak;
      const lineBefore = doc.lineOf(breakPos);
      const ws = indentForNewline(
        snapshot?.syntax ?? null,
        indentStyle,
        tabWidth,
        doc,
        lineBefore,
        breakPos,
        lineBefore,
      );
      return indentColumns(ws, tabWidth);
    }
    if (snapshot === null) return null;
    const rawQuery = snapshot.syntax.queryForLayer(snapshot.syntax.rootLayer, "indents");
    if (rawQuery === null) return null;
    const compiled = compileIndentQuery(rawQuery);
    const lineIdx = doc.lineOf(pos);
    const fnw = firstNonWhitespace(doc, lineIdx);
    const targetPos = fnw !== null ? doc.lineStart(lineIdx) + fnw : pos;
    const width = indentWidth(indentStyle, tabWidth);
    const computed = treesitterIndentForPos(
      compiled,
      snapshot.syntax,
      tabWidth,
      width,
      doc,
      lineIdx,
      targetPos,
      false,
    );
    if (computed === null) return null;
    return indentColumns(computed.toString(indentStyle, tabWidth), tabWidth);
  });

  return [
    indentUnit.of(indentString(helixLang.indent)),
    helixIndentService,
    EditorState.languageData.of(() => [data]),
  ];
}

function initSyntaxField(mode: string): { fieldExtension: Extension; pool: SnapshotPool } {
  const pool = new SnapshotPool();
  const cachedOnCreate = getLoadedLanguageBundle(mode);
  const fieldExtension = cachedOnCreate
    ? syntaxTreeField.init((state) => {
        const syntax = SyntaxTree.parse(textSourceFromDoc(state.doc), mode);
        return createPooledSnapshot(mode, cachedOnCreate, state.doc, pool, syntax);
      })
    : syntaxTreeField;
  return { fieldExtension, pool };
}

/**
 * StateField-only tree-sitter extension for headless `EditorState` instances (such as tests),
 * returning a `dispose` callback that immediately releases the pool's WASM trees.
 */
export function createSyntaxStateField(mode: string): {
  readonly extension: Extension;
  dispose(): void;
} {
  if (!hasTreeSitterMode(mode)) {
    throw new Error(`tree-sitter mode ${JSON.stringify(mode)} is not registered`);
  }
  const { fieldExtension, pool } = initSyntaxField(mode);
  return {
    extension: fieldExtension,
    dispose: () => pool.clear(),
  };
}

/**
 * CodeMirror extension that lazily loads the tree-sitter grammar and Helix queries for `mode`,
 * keeps an incremental syntax tree in `syntaxTreeField`, and highlights visible ranges.
 */
export function treeSitterExtension(mode: string): Extension {
  if (!hasTreeSitterMode(mode)) {
    throw new Error(`tree-sitter mode ${JSON.stringify(mode)} is not registered`);
  }

  const { fieldExtension, pool } = initSyntaxField(mode);

  const plugin = ViewPlugin.fromClass(
    class implements PluginValue {
      decorations: DecorationSet;
      private destroyed = false;
      private readonly unsubscribeTheme: () => void;

      constructor(view: EditorView) {
        this.decorations = computeDecorations(view);
        this.unsubscribeTheme = onSyntaxThemeChange(() => {
          if (!this.destroyed) {
            view.dispatch({ effects: themeChangedEffect.of(null) });
          }
        });

        if (getSyntaxTree(view.state) === null) {
          void loadLanguageBundle(mode).then(
            (bundle) => {
              if (!this.destroyed) {
                view.dispatch({ effects: syntaxLoadedEffect.of({ mode, bundle, pool }) });
              }
            },
            (error: unknown) => {
              console.error(`[treesitter] failed to load ${mode}:`, error);
            },
          );
        }
      }

      update(update: ViewUpdate): void {
        const syntaxChanged = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(syntaxLoadedEffect) || e.is(themeChangedEffect)),
        );
        if (update.docChanged || update.viewportChanged || syntaxChanged) {
          this.decorations = computeDecorations(update.view);
        }
      }

      destroy(): void {
        this.destroyed = true;
        this.unsubscribeTheme();
        pool.clear();
      }
    },
    { decorations: (v) => v.decorations },
  );

  return [fieldExtension, plugin, languageMetadata(mode)];
}
