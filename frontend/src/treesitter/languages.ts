import { Language, Parser, Query } from "web-tree-sitter";
import runtimeWasmUrl from "web-tree-sitter/web-tree-sitter.wasm?url";
import commentHighlights from "../../vendor/tree-sitter/comment/highlights.scm?raw";
import commentWasmUrl from "../../vendor/tree-sitter/comment/tree-sitter-comment.wasm?url";
import haskellHighlights from "../../vendor/tree-sitter/haskell/highlights.scm?raw";
import haskellInjections from "../../vendor/tree-sitter/haskell/injections.scm?raw";
import haskellLocals from "../../vendor/tree-sitter/haskell/locals.scm?raw";
import haskellRainbows from "../../vendor/tree-sitter/haskell/rainbows.scm?raw";
import haskellTags from "../../vendor/tree-sitter/haskell/tags.scm?raw";
import haskellTextobjects from "../../vendor/tree-sitter/haskell/textobjects.scm?raw";
import haskellWasmUrl from "../../vendor/tree-sitter/haskell/tree-sitter-haskell.wasm?url";

/** Auxiliary query kinds exposed for downstream syntax commands (textobjects, indent, symbols). */
export type QueryKind = "textobjects" | "indents" | "tags" | "rainbows";

export enum IncludedChildren {
  None = 0,
  All = 1,
  Unnamed = 2,
}

export interface InjectionProperties {
  readonly includeChildren: IncludedChildren;
  readonly language: string | null;
  readonly combined: boolean;
}

export interface CompiledHighlightQuery {
  readonly query: Query;
  /** First pattern index belonging to `locals.scm` (`>= highlights.scm` pattern count). */
  readonly firstLocalsPattern: number;
  /** Patterns carrying `(#is-not? local)`. */
  readonly nonLocalPatterns: ReadonlySet<number>;
  readonly hasLocalReference: boolean;
}

export interface CompiledLocalQuery {
  readonly query: Query;
  /** Patterns carrying `(#set! local.scope-inherits false)` (or any value !== "true"). */
  readonly notScopeInherits: ReadonlySet<number>;
  readonly hasDefinitions: boolean;
}

export interface CompiledInjectionQuery {
  readonly query: Query;
  readonly properties: ReadonlyMap<number, InjectionProperties>;
  readonly hasContentCapture: boolean;
  readonly hasCombinedPattern: boolean;
}

/** Loaded grammar and compiled queries for a single language. */
export interface LanguageBundle {
  readonly name: string;
  readonly language: Language;
  readonly highlightQuery: CompiledHighlightQuery | null;
  readonly localQuery: CompiledLocalQuery | null;
  readonly injectionQuery: CompiledInjectionQuery | null;
  /** Languages referenced statically by this language's `injections.scm` that we ship. */
  readonly staticInjections: readonly string[];
  /** Compiles and caches an auxiliary query (`textobjects`, `indents`, `tags`, `rainbows`). */
  query(kind: QueryKind): Query | null;
}

interface LanguageSpec {
  readonly name: string;
  readonly wasmUrl: string;
  readonly injectionRegex: RegExp;
  readonly injectionOnly?: boolean;
  readonly queries: {
    readonly highlights?: string;
    readonly locals?: string;
    readonly injections?: string;
    readonly textobjects?: string;
    readonly indents?: string;
    readonly tags?: string;
    readonly rainbows?: string;
  };
}

const REGISTRY: Readonly<Record<string, LanguageSpec>> = {
  haskell: {
    name: "haskell",
    wasmUrl: haskellWasmUrl,
    injectionRegex: /^(hs|haskell)$/,
    queries: {
      highlights: haskellHighlights,
      locals: haskellLocals,
      injections: haskellInjections,
      textobjects: haskellTextobjects,
      tags: haskellTags,
      rainbows: haskellRainbows,
    },
  },
  comment: {
    name: "comment",
    wasmUrl: commentWasmUrl,
    injectionRegex: /^comment$/,
    injectionOnly: true,
    queries: {
      highlights: commentHighlights,
    },
  },
};

/** Whether Workshop has a tree-sitter grammar for this editor mode. */
export function hasTreeSitterMode(mode: string): boolean {
  const spec = REGISTRY[mode];
  return spec !== undefined && !spec.injectionOnly;
}

/** Resolves an injection language marker to a shipped language name, or null if not shipped. */
export function resolveInjectionLanguage(kind: "name" | "match", marker: string): string | null {
  if (kind === "name") {
    return Object.hasOwn(REGISTRY, marker) ? marker : null;
  }
  const trimmed = marker.trim();
  if (Object.hasOwn(REGISTRY, trimmed)) return trimmed;
  let best: string | null = null;
  let bestLen = -1;
  for (const spec of Object.values(REGISTRY)) {
    const m = spec.injectionRegex.exec(trimmed);
    if (m && m[0].length > bestLen) {
      best = spec.name;
      bestLen = m[0].length;
    }
  }
  return best;
}

let initPromise: Promise<void> | null = null;
const bundlePromises = new Map<string, Promise<LanguageBundle>>();
const loadedBundles = new Map<string, LanguageBundle>();

export type WasmBytesLoader = (url: string) => Promise<Uint8Array>;

let customWasmLoader: WasmBytesLoader | null = null;

/** Overrides how `.wasm` asset URLs are loaded (used by Node/Vitest tests). */
export function setWasmBytesLoader(loader: WasmBytesLoader | null): void {
  customWasmLoader = loader;
}

async function loadWasmBytes(url: string): Promise<Uint8Array> {
  if (customWasmLoader) {
    return customWasmLoader(url);
  }
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`failed to fetch tree-sitter wasm ${url} (${response.status})`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Initialises the web-tree-sitter WASM runtime once. */
export function initTreeSitter(): Promise<void> {
  if (!initPromise) {
    initPromise = (async () => {
      if (customWasmLoader) {
        const wasmBinary = await customWasmLoader(runtimeWasmUrl);
        await Parser.init({ wasmBinary });
      } else {
        await Parser.init({ locateFile: () => runtimeWasmUrl });
      }
    })();
  }
  return initPromise;
}

function compileHighlightQuery(
  language: Language,
  highlightsSource: string | undefined,
  localsSource: string | undefined,
): CompiledHighlightQuery | null {
  const hl = highlightsSource ?? "";
  const loc = localsSource ?? "";
  if (!hl && !loc) return null;

  // Match tree-house's `HighlightQuery::new`: concatenate highlights.scm + locals.scm, record the
  // boundary before disabling captures (which can invalidate startIndexForPattern), then disable
  // `local.scope` and `local.definition.*` so only highlights and `@local.reference` remain.
  const combined = loc ? `${hl}\n${loc}` : hl;
  const query = new Query(language, combined);
  const patternCount = query.patternCount();

  let firstLocalsPattern = patternCount;
  if (loc) {
    const localsOffset = hl.length + 1;
    for (let p = 0; p < patternCount; p++) {
      if (query.startIndexForPattern(p) >= localsOffset) {
        firstLocalsPattern = p;
        break;
      }
    }
  }

  const nonLocalPatterns = new Set<number>();
  for (let p = 0; p < patternCount; p++) {
    const refuted = query.refutedProperties[p];
    if (refuted && Object.hasOwn(refuted, "local") && refuted.local === null) {
      nonLocalPatterns.add(p);
    }
  }

  query.disableCapture("local.scope");
  for (const name of query.captureNames) {
    if (name.startsWith("local.definition.")) {
      query.disableCapture(name);
    }
  }

  return {
    query,
    firstLocalsPattern,
    nonLocalPatterns,
    hasLocalReference: query.captureIndexForName("local.reference") !== -1,
  };
}

function compileLocalQuery(
  language: Language,
  localsSource: string | undefined,
): CompiledLocalQuery | null {
  if (!localsSource?.trim()) return null;
  const query = new Query(language, localsSource);
  const notScopeInherits = new Set<number>();
  const patternCount = query.patternCount();
  for (let p = 0; p < patternCount; p++) {
    const props = query.setProperties[p];
    if (props && Object.hasOwn(props, "local.scope-inherits")) {
      const val = props["local.scope-inherits"];
      if (val !== null && val !== "true") {
        notScopeInherits.add(p);
      }
    }
  }
  const hasDefinitions = query.captureNames.some((n) => n.startsWith("local.definition."));
  query.disableCapture("local.reference");
  return { query, notScopeInherits, hasDefinitions };
}

function compileInjectionQuery(
  language: Language,
  injectionsSource: string | undefined,
): { compiled: CompiledInjectionQuery | null; staticInjections: string[] } {
  if (!injectionsSource?.trim()) return { compiled: null, staticInjections: [] };
  const query = new Query(language, injectionsSource);
  const properties = new Map<number, InjectionProperties>();
  const staticSet = new Set<string>();
  let hasCombinedPattern = false;
  const patternCount = query.patternCount();
  for (let p = 0; p < patternCount; p++) {
    const props = query.setProperties[p];
    if (!props) continue;
    let includeChildren = IncludedChildren.None;
    if (Object.hasOwn(props, "injection.include-children")) {
      includeChildren = IncludedChildren.All;
    } else if (Object.hasOwn(props, "injection.include-unnamed-children")) {
      includeChildren = IncludedChildren.Unnamed;
    }
    const langVal = props["injection.language"] ?? null;
    const combined = Object.hasOwn(props, "injection.combined");
    if (combined) hasCombinedPattern = true;
    if (includeChildren !== IncludedChildren.None || langVal !== null || combined) {
      properties.set(p, { includeChildren, language: langVal, combined });
    }
    if (langVal !== null) {
      const resolved = resolveInjectionLanguage("name", langVal);
      if (resolved !== null) staticSet.add(resolved);
    }
  }
  return {
    compiled: {
      query,
      properties,
      hasContentCapture: query.captureIndexForName("injection.content") !== -1,
      hasCombinedPattern,
    },
    staticInjections: [...staticSet],
  };
}

/** Loads and caches a language's grammar and compiled queries, plus any shipped static injections. */
export function loadLanguageBundle(name: string): Promise<LanguageBundle> {
  const existing = bundlePromises.get(name);
  if (existing) return existing;

  const spec = REGISTRY[name];
  if (!spec) {
    return Promise.reject(
      new Error(`no tree-sitter grammar registered for ${JSON.stringify(name)}`),
    );
  }

  const promise = (async () => {
    await initTreeSitter();
    const bytes = await loadWasmBytes(spec.wasmUrl);
    const language = await Language.load(bytes);
    const highlightQuery = compileHighlightQuery(
      language,
      spec.queries.highlights,
      spec.queries.locals,
    );
    const localQuery = compileLocalQuery(language, spec.queries.locals);
    const { compiled: injectionQuery, staticInjections } = compileInjectionQuery(
      language,
      spec.queries.injections,
    );

    const auxCache = new Map<QueryKind, Query | null>();
    const bundle: LanguageBundle = {
      name: spec.name,
      language,
      highlightQuery,
      localQuery,
      injectionQuery,
      staticInjections,
      query(kind: QueryKind): Query | null {
        const cached = auxCache.get(kind);
        if (cached !== undefined) return cached;
        const src = spec.queries[kind];
        const compiled = src?.trim() ? new Query(language, src) : null;
        auxCache.set(kind, compiled);
        return compiled;
      },
    };
    loadedBundles.set(name, bundle);

    // Preload any shipped static injection grammars (such as `comment`) in parallel.
    await Promise.all(
      staticInjections.filter((dep) => dep !== name).map((dep) => loadLanguageBundle(dep)),
    );
    return bundle;
  })();

  bundlePromises.set(name, promise);
  return promise;
}

/** Returns an already-loaded language bundle synchronously, or null if not yet loaded. */
export function getLoadedLanguageBundle(name: string): LanguageBundle | null {
  return loadedBundles.get(name) ?? null;
}
