import { Language, Parser, Query } from "web-tree-sitter";
import runtimeWasmUrl from "web-tree-sitter/web-tree-sitter.wasm?url";
import commentHighlights from "../../vendor/tree-sitter/comment/highlights.scm?raw";
import commentWasmUrl from "../../vendor/tree-sitter/comment/tree-sitter-comment.wasm?url";
import cppHighlights from "../../vendor/tree-sitter/cpp/highlights.scm?raw";
import cppIndents from "../../vendor/tree-sitter/cpp/indents.scm?raw";
import cppInjections from "../../vendor/tree-sitter/cpp/injections.scm?raw";
import cppLocals from "../../vendor/tree-sitter/cpp/locals.scm?raw";
import cppRainbows from "../../vendor/tree-sitter/cpp/rainbows.scm?raw";
import cppTags from "../../vendor/tree-sitter/cpp/tags.scm?raw";
import cppTextobjects from "../../vendor/tree-sitter/cpp/textobjects.scm?raw";
import cppWasmUrl from "../../vendor/tree-sitter/cpp/tree-sitter-cpp.wasm?url";
import goHighlights from "../../vendor/tree-sitter/go/highlights.scm?raw";
import goIndents from "../../vendor/tree-sitter/go/indents.scm?raw";
import goInjections from "../../vendor/tree-sitter/go/injections.scm?raw";
import goLocals from "../../vendor/tree-sitter/go/locals.scm?raw";
import goRainbows from "../../vendor/tree-sitter/go/rainbows.scm?raw";
import goTags from "../../vendor/tree-sitter/go/tags.scm?raw";
import goTextobjects from "../../vendor/tree-sitter/go/textobjects.scm?raw";
import goWasmUrl from "../../vendor/tree-sitter/go/tree-sitter-go.wasm?url";
import goFormatStringHighlights from "../../vendor/tree-sitter/go-format-string/highlights.scm?raw";
import goFormatStringRainbows from "../../vendor/tree-sitter/go-format-string/rainbows.scm?raw";
import goFormatStringWasmUrl from "../../vendor/tree-sitter/go-format-string/tree-sitter-go-format-string.wasm?url";
import haskellHighlights from "../../vendor/tree-sitter/haskell/highlights.scm?raw";
import haskellInjections from "../../vendor/tree-sitter/haskell/injections.scm?raw";
import haskellLocals from "../../vendor/tree-sitter/haskell/locals.scm?raw";
import haskellRainbows from "../../vendor/tree-sitter/haskell/rainbows.scm?raw";
import haskellTags from "../../vendor/tree-sitter/haskell/tags.scm?raw";
import haskellTextobjects from "../../vendor/tree-sitter/haskell/textobjects.scm?raw";
import haskellWasmUrl from "../../vendor/tree-sitter/haskell/tree-sitter-haskell.wasm?url";
import jsdocHighlights from "../../vendor/tree-sitter/jsdoc/highlights.scm?raw";
import jsdocInjections from "../../vendor/tree-sitter/jsdoc/injections.scm?raw";
import jsdocWasmUrl from "../../vendor/tree-sitter/jsdoc/tree-sitter-jsdoc.wasm?url";
import pythonHighlights from "../../vendor/tree-sitter/python/highlights.scm?raw";
import pythonIndents from "../../vendor/tree-sitter/python/indents.scm?raw";
import pythonInjections from "../../vendor/tree-sitter/python/injections.scm?raw";
import pythonLocals from "../../vendor/tree-sitter/python/locals.scm?raw";
import pythonRainbows from "../../vendor/tree-sitter/python/rainbows.scm?raw";
import pythonTags from "../../vendor/tree-sitter/python/tags.scm?raw";
import pythonTextobjects from "../../vendor/tree-sitter/python/textobjects.scm?raw";
import pythonWasmUrl from "../../vendor/tree-sitter/python/tree-sitter-python.wasm?url";
import regexHighlights from "../../vendor/tree-sitter/regex/highlights.scm?raw";
import regexRainbows from "../../vendor/tree-sitter/regex/rainbows.scm?raw";
import regexWasmUrl from "../../vendor/tree-sitter/regex/tree-sitter-regex.wasm?url";
import rustHighlights from "../../vendor/tree-sitter/rust/highlights.scm?raw";
import rustIndents from "../../vendor/tree-sitter/rust/indents.scm?raw";
import rustInjections from "../../vendor/tree-sitter/rust/injections.scm?raw";
import rustLocals from "../../vendor/tree-sitter/rust/locals.scm?raw";
import rustRainbows from "../../vendor/tree-sitter/rust/rainbows.scm?raw";
import rustTags from "../../vendor/tree-sitter/rust/tags.scm?raw";
import rustTextobjects from "../../vendor/tree-sitter/rust/textobjects.scm?raw";
import rustWasmUrl from "../../vendor/tree-sitter/rust/tree-sitter-rust.wasm?url";
import rustFormatArgsHighlights from "../../vendor/tree-sitter/rust-format-args/highlights.scm?raw";
import rustFormatArgsWasmUrl from "../../vendor/tree-sitter/rust-format-args/tree-sitter-rust-format-args.wasm?url";
import rustFormatArgsMacroHighlights from "../../vendor/tree-sitter/rust-format-args-macro/highlights.scm?raw";
import rustFormatArgsMacroIndents from "../../vendor/tree-sitter/rust-format-args-macro/indents.scm?raw";
import rustFormatArgsMacroInjections from "../../vendor/tree-sitter/rust-format-args-macro/injections.scm?raw";
import rustFormatArgsMacroLocals from "../../vendor/tree-sitter/rust-format-args-macro/locals.scm?raw";
import rustFormatArgsMacroRainbows from "../../vendor/tree-sitter/rust-format-args-macro/rainbows.scm?raw";
import rustFormatArgsMacroTextobjects from "../../vendor/tree-sitter/rust-format-args-macro/textobjects.scm?raw";
import typescriptHighlights from "../../vendor/tree-sitter/typescript/highlights.scm?raw";
import typescriptIndents from "../../vendor/tree-sitter/typescript/indents.scm?raw";
import typescriptInjections from "../../vendor/tree-sitter/typescript/injections.scm?raw";
import typescriptLocals from "../../vendor/tree-sitter/typescript/locals.scm?raw";
import typescriptRainbows from "../../vendor/tree-sitter/typescript/rainbows.scm?raw";
import typescriptTags from "../../vendor/tree-sitter/typescript/tags.scm?raw";
import typescriptTextobjects from "../../vendor/tree-sitter/typescript/textobjects.scm?raw";
import typescriptWasmUrl from "../../vendor/tree-sitter/typescript/tree-sitter-typescript.wasm?url";

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
  python: {
    name: "python",
    wasmUrl: pythonWasmUrl,
    injectionRegex: /^py(thon)?$/,
    queries: {
      highlights: pythonHighlights,
      locals: pythonLocals,
      injections: pythonInjections,
      textobjects: pythonTextobjects,
      indents: pythonIndents,
      tags: pythonTags,
      rainbows: pythonRainbows,
    },
  },
  typescript: {
    name: "typescript",
    wasmUrl: typescriptWasmUrl,
    injectionRegex: /^(ts|typescript)$/,
    queries: {
      highlights: typescriptHighlights,
      locals: typescriptLocals,
      injections: typescriptInjections,
      textobjects: typescriptTextobjects,
      indents: typescriptIndents,
      tags: typescriptTags,
      rainbows: typescriptRainbows,
    },
  },
  go: {
    name: "go",
    wasmUrl: goWasmUrl,
    injectionRegex: /^go$/,
    queries: {
      highlights: goHighlights,
      locals: goLocals,
      injections: goInjections,
      textobjects: goTextobjects,
      indents: goIndents,
      tags: goTags,
      rainbows: goRainbows,
    },
  },
  rust: {
    name: "rust",
    wasmUrl: rustWasmUrl,
    injectionRegex: /^(rs|rust)$/,
    queries: {
      highlights: rustHighlights,
      locals: rustLocals,
      injections: rustInjections,
      textobjects: rustTextobjects,
      indents: rustIndents,
      tags: rustTags,
      rainbows: rustRainbows,
    },
  },
  cpp: {
    name: "cpp",
    wasmUrl: cppWasmUrl,
    injectionRegex: /^cpp$/,
    queries: {
      highlights: cppHighlights,
      locals: cppLocals,
      injections: cppInjections,
      textobjects: cppTextobjects,
      indents: cppIndents,
      tags: cppTags,
      rainbows: cppRainbows,
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
  regex: {
    name: "regex",
    wasmUrl: regexWasmUrl,
    injectionRegex: /^regex$/,
    injectionOnly: true,
    queries: {
      highlights: regexHighlights,
      rainbows: regexRainbows,
    },
  },
  jsdoc: {
    name: "jsdoc",
    wasmUrl: jsdocWasmUrl,
    injectionRegex: /^jsdoc$/,
    injectionOnly: true,
    queries: {
      highlights: jsdocHighlights,
      injections: jsdocInjections,
    },
  },
  "rust-format-args": {
    name: "rust-format-args",
    wasmUrl: rustFormatArgsWasmUrl,
    injectionRegex: /^rust-format-args$/,
    injectionOnly: true,
    queries: {
      highlights: rustFormatArgsHighlights,
    },
  },
  "rust-format-args-macro": {
    name: "rust-format-args-macro",
    wasmUrl: rustWasmUrl,
    injectionRegex: /^rust-format-args-macro$/,
    injectionOnly: true,
    queries: {
      highlights: rustFormatArgsMacroHighlights,
      locals: rustFormatArgsMacroLocals,
      injections: rustFormatArgsMacroInjections,
      textobjects: rustFormatArgsMacroTextobjects,
      indents: rustFormatArgsMacroIndents,
      rainbows: rustFormatArgsMacroRainbows,
    },
  },
  "go-format-string": {
    name: "go-format-string",
    wasmUrl: goFormatStringWasmUrl,
    injectionRegex: /^go-format-string$/,
    injectionOnly: true,
    queries: {
      highlights: goFormatStringHighlights,
      rainbows: goFormatStringRainbows,
    },
  },
};

/** Whether Workshop has a tree-sitter grammar for this editor mode. */
export function hasTreeSitterMode(mode: string): boolean {
  const spec = REGISTRY[mode];
  return spec !== undefined && !spec.injectionOnly;
}

/** All registered non-injection editor modes backed by tree-sitter. */
export function registeredTreeSitterModes(): readonly string[] {
  return Object.values(REGISTRY)
    .filter((spec) => !spec.injectionOnly)
    .map((spec) => spec.name);
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

type BundleListener = (name: string) => void;

let initPromise: Promise<void> | null = null;
const languagePromises = new Map<string, Promise<Language>>();
const singleBundlePromises = new Map<string, Promise<LanguageBundle>>();
const bundlePromises = new Map<string, Promise<LanguageBundle>>();
const loadedBundles = new Map<string, LanguageBundle>();
const bundleListeners = new Set<BundleListener>();

export type WasmBytesLoader = (url: string) => Promise<Uint8Array>;

let customWasmLoader: WasmBytesLoader | null = null;

/** Overrides how `.wasm` asset URLs are loaded (used by Node/Vitest tests). */
export function setWasmBytesLoader(loader: WasmBytesLoader | null): void {
  customWasmLoader = loader;
}

/** Subscribes to language bundles finishing loading (including their static injections). */
export function onLanguageBundleLoaded(listener: BundleListener): () => void {
  bundleListeners.add(listener);
  return () => {
    bundleListeners.delete(listener);
  };
}

function notifyBundleLoaded(name: string): void {
  for (const listener of bundleListeners) listener(name);
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
    const promise = (async () => {
      if (customWasmLoader) {
        const wasmBinary = await customWasmLoader(runtimeWasmUrl);
        await Parser.init({ wasmBinary });
      } else {
        await Parser.init({ locateFile: () => runtimeWasmUrl });
      }
    })();
    initPromise = promise;
    promise.catch(() => {
      if (initPromise === promise) initPromise = null;
    });
  }
  return initPromise;
}

function loadWasmLanguage(wasmUrl: string): Promise<Language> {
  const existing = languagePromises.get(wasmUrl);
  if (existing) return existing;
  const promise = (async () => {
    await initTreeSitter();
    const bytes = await loadWasmBytes(wasmUrl);
    return Language.load(bytes);
  })();
  languagePromises.set(wasmUrl, promise);
  promise.catch(() => {
    if (languagePromises.get(wasmUrl) === promise) languagePromises.delete(wasmUrl);
  });
  return promise;
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

function loadSingleBundle(name: string): Promise<LanguageBundle> {
  const existing = singleBundlePromises.get(name);
  if (existing) return existing;

  const spec = REGISTRY[name];
  if (!spec) {
    return Promise.reject(
      new Error(`no tree-sitter grammar registered for ${JSON.stringify(name)}`),
    );
  }

  const promise = (async () => {
    const language = await loadWasmLanguage(spec.wasmUrl);
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
    return bundle;
  })();

  singleBundlePromises.set(name, promise);
  promise.catch(() => {
    if (singleBundlePromises.get(name) === promise) singleBundlePromises.delete(name);
  });
  return promise;
}

/** Loads and caches a language's grammar and compiled queries, plus any shipped static injections. */
export function loadLanguageBundle(name: string): Promise<LanguageBundle> {
  const existing = bundlePromises.get(name);
  if (existing) return existing;

  if (!Object.hasOwn(REGISTRY, name)) {
    return Promise.reject(
      new Error(`no tree-sitter grammar registered for ${JSON.stringify(name)}`),
    );
  }

  const promise = (async () => {
    const root = await loadSingleBundle(name);
    // BFS over transitive static injections so mutually-injecting languages (such as `rust` and
    // `rust-format-args-macro`) load without deadlocking.
    const visited = new Set<string>([name]);
    let frontier = root.staticInjections.filter((dep) => !visited.has(dep));
    while (frontier.length > 0) {
      for (const dep of frontier) visited.add(dep);
      const loaded = await Promise.all(frontier.map((dep) => loadSingleBundle(dep)));
      const next: string[] = [];
      for (const depBundle of loaded) {
        for (const dep of depBundle.staticInjections) {
          if (!visited.has(dep)) next.push(dep);
        }
      }
      frontier = next;
    }
    notifyBundleLoaded(name);
    return root;
  })();

  bundlePromises.set(name, promise);
  promise.catch(() => {
    if (bundlePromises.get(name) === promise) bundlePromises.delete(name);
  });
  return promise;
}

/** Returns an already-loaded language bundle synchronously, or null if not yet loaded. */
export function getLoadedLanguageBundle(name: string): LanguageBundle | null {
  return loadedBundles.get(name) ?? null;
}
