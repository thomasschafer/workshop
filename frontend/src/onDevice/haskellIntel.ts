// Import-aware Haskell completions, hover, and signature help backed by the open document,
// `lib/Aoc.hs`, GHC `-Wmissing-signatures` inferred types, and a curated signature index for
// Prelude + Workshop's bundled GHC 9.14 WASM packages.

export interface SymbolEntry {
  name: string;
  signature: string;
  module: string;
  /** LSP CompletionItemKind: 3 = Function, 6 = Variable, 7 = Class/Type */
  kind: 3 | 6 | 7;
  doc?: string | undefined;
}

export interface ParsedImport {
  module: string;
  qualified: boolean;
  alias: string | null;
  only: Set<string> | null;
  hiding: Set<string> | null;
}

const MODULE_SYMBOLS: Readonly<Record<string, readonly [string, string, string?][]>> = {
  Prelude: [
    ["map", "(a -> b) -> [a] -> [b]", "Apply a function to every element of a list."],
    ["filter", "(a -> Bool) -> [a] -> [a]", "Keep elements matching a predicate."],
    ["foldl", "Foldable t => (b -> a -> b) -> b -> t a -> b"],
    ["foldl'", "Foldable t => (b -> a -> b) -> b -> t a -> b", "Strict left fold."],
    ["foldr", "Foldable t => (a -> b -> b) -> b -> t a -> b"],
    ["foldMap", "(Foldable t, Monoid m) => (a -> m) -> t a -> m"],
    ["concat", "Foldable t => t [a] -> [a]"],
    ["concatMap", "Foldable t => (a -> [b]) -> t a -> [b]"],
    ["zip", "[a] -> [b] -> [(a, b)]"],
    ["zipWith", "(a -> b -> c) -> [a] -> [b] -> [c]"],
    ["unzip", "[(a, b)] -> ([a], [b])"],
    ["take", "Int -> [a] -> [a]"],
    ["drop", "Int -> [a] -> [a]"],
    ["takeWhile", "(a -> Bool) -> [a] -> [a]"],
    ["dropWhile", "(a -> Bool) -> [a] -> [a]"],
    ["span", "(a -> Bool) -> [a] -> ([a], [a])"],
    ["break", "(a -> Bool) -> [a] -> ([a], [a])"],
    ["splitAt", "Int -> [a] -> ([a], [a])"],
    ["reverse", "[a] -> [a]"],
    ["length", "Foldable t => t a -> Int"],
    ["null", "Foldable t => t a -> Bool"],
    ["elem", "(Foldable t, Eq a) => a -> t a -> Bool"],
    ["notElem", "(Foldable t, Eq a) => a -> t a -> Bool"],
    ["sum", "(Foldable t, Num a) => t a -> a"],
    ["product", "(Foldable t, Num a) => t a -> a"],
    ["minimum", "(Foldable t, Ord a) => t a -> a"],
    ["maximum", "(Foldable t, Ord a) => t a -> a"],
    ["and", "Foldable t => t Bool -> Bool"],
    ["or", "Foldable t => t Bool -> Bool"],
    ["any", "Foldable t => (a -> Bool) -> t a -> Bool"],
    ["all", "Foldable t => (a -> Bool) -> t a -> Bool"],
    ["head", "[a] -> a"],
    ["tail", "[a] -> [a]"],
    ["init", "[a] -> [a]"],
    ["last", "[a] -> a"],
    ["lines", "String -> [String]"],
    ["unlines", "[String] -> String"],
    ["words", "String -> [String]"],
    ["unwords", "[String] -> String"],
    ["read", "Read a => String -> a"],
    ["show", "Show a => a -> String"],
    ["print", "Show a => a -> IO ()"],
    ["putStr", "String -> IO ()"],
    ["putStrLn", "String -> IO ()"],
    ["getContents", "IO String"],
    ["getLine", "IO String"],
    ["readLn", "Read a => IO a"],
    ["interact", "(String -> String) -> IO ()"],
    ["fst", "(a, b) -> a"],
    ["snd", "(a, b) -> b"],
    ["curry", "((a, b) -> c) -> a -> b -> c"],
    ["uncurry", "(a -> b -> c) -> (a, b) -> c"],
    ["id", "a -> a"],
    ["const", "a -> b -> a"],
    ["flip", "(a -> b -> c) -> b -> a -> c"],
    ["fmap", "Functor f => (a -> b) -> f a -> f b"],
    ["pure", "Applicative f => a -> f a"],
    ["traverse", "(Traversable t, Applicative f) => (a -> f b) -> t a -> f (t b)"],
    ["sequenceA", "(Traversable t, Applicative f) => t (f a) -> f (t a)"],
    ["maybe", "b -> (a -> b) -> Maybe a -> b"],
    ["either", "(a -> c) -> (b -> c) -> Either a b -> c"],
    ["lookup", "Eq a => a -> [(a, b)] -> Maybe b"],
    ["iterate", "(a -> a) -> a -> [a]"],
    ["repeat", "a -> [a]"],
    ["replicate", "Int -> a -> [a]"],
    ["cycle", "[a] -> [a]"],
    ["scanl", "(b -> a -> b) -> b -> [a] -> [b]"],
    ["scanr", "(a -> b -> b) -> b -> [a] -> [b]"],
    ["gcd", "Integral a => a -> a -> a"],
    ["lcm", "Integral a => a -> a -> a"],
    ["div", "Integral a => a -> a -> a"],
    ["mod", "Integral a => a -> a -> a"],
    ["divMod", "Integral a => a -> a -> (a, a)"],
    ["quotRem", "Integral a => a -> a -> (a, a)"],
    ["fromIntegral", "(Integral a, Num b) => a -> b"],
    ["abs", "Num a => a -> a"],
    ["signum", "Num a => a -> a"],
    ["min", "Ord a => a -> a -> a"],
    ["max", "Ord a => a -> a -> a"],
    ["compare", "Ord a => a -> a -> Ordering"],
    ["even", "Integral a => a -> Bool"],
    ["odd", "Integral a => a -> Bool"],
    ["not", "Bool -> Bool"],
    ["otherwise", "Bool"],
    ["error", "HasCallStack => String -> a"],
    ["undefined", "HasCallStack => a"],
  ],
  "Data.List": [
    ["sort", "Ord a => [a] -> [a]"],
    ["sortOn", "Ord b => (a -> b) -> [a] -> [a]"],
    ["sortBy", "(a -> a -> Ordering) -> [a] -> [a]"],
    ["group", "Eq a => [a] -> [[a]]"],
    ["groupBy", "(a -> a -> Bool) -> [a] -> [[a]]"],
    ["nub", "Eq a => [a] -> [a]"],
    ["transpose", "[[a]] -> [[a]]"],
    ["subsequences", "[a] -> [[a]]"],
    ["permutations", "[a] -> [[a]]"],
    ["tails", "[a] -> [[a]]"],
    ["inits", "[a] -> [[a]]"],
    ["intercalate", "[a] -> [[a]] -> [a]"],
    ["intersperse", "a -> [a] -> [a]"],
    ["partition", "(a -> Bool) -> [a] -> ([a], [a])"],
    ["find", "Foldable t => (a -> Bool) -> t a -> Maybe a"],
    ["elemIndex", "Eq a => a -> [a] -> Maybe Int"],
    ["elemIndices", "Eq a => a -> [a] -> [Int]"],
    ["findIndex", "(a -> Bool) -> [a] -> Maybe Int"],
    ["isPrefixOf", "Eq a => [a] -> [a] -> Bool"],
    ["isSuffixOf", "Eq a => [a] -> [a] -> Bool"],
    ["isInfixOf", "Eq a => [a] -> [a] -> Bool"],
    ["stripPrefix", "Eq a => [a] -> [a] -> Maybe [a]"],
    ["unfoldr", "(b -> Maybe (a, b)) -> b -> [a]"],
    ["foldl'", "Foldable t => (b -> a -> b) -> b -> t a -> b"],
    ["scanl'", "(b -> a -> b) -> b -> [a] -> [b]"],
    ["maximumBy", "Foldable t => (a -> a -> Ordering) -> t a -> a"],
    ["minimumBy", "Foldable t => (a -> a -> Ordering) -> t a -> a"],
  ],
  "Data.Maybe": [
    ["fromMaybe", "a -> Maybe a -> a"],
    ["isJust", "Maybe a -> Bool"],
    ["isNothing", "Maybe a -> Bool"],
    ["catMaybes", "[Maybe a] -> [a]"],
    ["mapMaybe", "(a -> Maybe b) -> [a] -> [b]"],
    ["listToMaybe", "[a] -> Maybe a"],
    ["maybeToList", "Maybe a -> [a]"],
  ],
  "Data.Either": [
    ["lefts", "[Either a b] -> [a]"],
    ["rights", "[Either a b] -> [b]"],
    ["partitionEithers", "[Either a b] -> ([a], [b])"],
    ["fromLeft", "a -> Either a b -> a"],
    ["fromRight", "b -> Either a b -> b"],
    ["isLeft", "Either a b -> Bool"],
    ["isRight", "Either a b -> Bool"],
  ],
  "Data.Char": [
    ["isDigit", "Char -> Bool"],
    ["isAlpha", "Char -> Bool"],
    ["isAlphaNum", "Char -> Bool"],
    ["isSpace", "Char -> Bool"],
    ["isUpper", "Char -> Bool"],
    ["isLower", "Char -> Bool"],
    ["toUpper", "Char -> Char"],
    ["toLower", "Char -> Char"],
    ["ord", "Char -> Int"],
    ["chr", "Int -> Char"],
    ["digitToInt", "Char -> Int"],
    ["intToDigit", "Int -> Char"],
  ],
  "Data.Ord": [
    ["comparing", "Ord a => (b -> a) -> b -> b -> Ordering"],
    ["Down", "a -> Down a"],
  ],
  "Data.Function": [
    ["on", "(b -> b -> c) -> (a -> b) -> a -> a -> c"],
    ["fix", "(a -> a) -> a"],
  ],
  "Control.Monad": [
    ["when", "Applicative f => Bool -> f () -> f ()"],
    ["unless", "Applicative f => Bool -> f () -> f ()"],
    ["guard", "Alternative f => Bool -> f ()"],
    ["forM", "(Traversable t, Monad m) => t a -> (a -> m b) -> m (t b)"],
    ["forM_", "(Foldable t, Monad m) => t a -> (a -> m b) -> m ()"],
    ["mapM_", "(Foldable t, Monad m) => (a -> m b) -> t a -> m ()"],
    ["foldM", "(Foldable t, Monad m) => (b -> a -> m b) -> b -> t a -> m b"],
    ["replicateM", "Applicative m => Int -> m a -> m [a]"],
    ["join", "Monad m => m (m a) -> m a"],
    ["void", "Functor f => f a -> f ()"],
    ["ap", "Monad m => m (a -> b) -> m a -> m b"],
  ],
  "Data.Map": [
    ["empty", "Map k a"],
    ["singleton", "k -> a -> Map k a"],
    ["fromList", "Ord k => [(k, a)] -> Map k a"],
    ["fromListWith", "Ord k => (a -> a -> a) -> [(k, a)] -> Map k a"],
    ["toList", "Map k a -> [(k, a)]"],
    ["insert", "Ord k => k -> a -> Map k a -> Map k a"],
    ["insertWith", "Ord k => (a -> a -> a) -> k -> a -> Map k a -> Map k a"],
    ["delete", "Ord k => k -> Map k a -> Map k a"],
    ["adjust", "Ord k => (a -> a) -> k -> Map k a -> Map k a"],
    ["update", "Ord k => (a -> Maybe a) -> k -> Map k a -> Map k a"],
    ["alter", "Ord k => (Maybe a -> Maybe a) -> k -> Map k a -> Map k a"],
    ["lookup", "Ord k => k -> Map k a -> Maybe a"],
    ["findWithDefault", "Ord k => a -> k -> Map k a -> a"],
    ["member", "Ord k => k -> Map k a -> Bool"],
    ["notMember", "Ord k => k -> Map k a -> Bool"],
    ["keys", "Map k a -> [k]"],
    ["elems", "Map k a -> [a]"],
    ["assocs", "Map k a -> [(k, a)]"],
    ["size", "Map k a -> Int"],
    ["null", "Map k a -> Bool"],
    ["union", "Ord k => Map k a -> Map k a -> Map k a"],
    ["unionWith", "Ord k => (a -> a -> a) -> Map k a -> Map k a -> Map k a"],
    ["intersectionWith", "Ord k => (a -> b -> c) -> Map k a -> Map k b -> Map k c"],
    ["difference", "Ord k => Map k a -> Map k b -> Map k a"],
    ["filter", "(a -> Bool) -> Map k a -> Map k a"],
    ["filterWithKey", "(k -> a -> Bool) -> Map k a -> Map k a"],
    ["map", "(a -> b) -> Map k a -> Map k b"],
    ["mapWithKey", "(k -> a -> b) -> Map k a -> Map k b"],
    ["foldrWithKey", "(k -> a -> b -> b) -> b -> Map k a -> b"],
    ["foldlWithKey'", "(a -> k -> b -> a) -> a -> Map k b -> a"],
  ],
  "Data.Set": [
    ["empty", "Set a"],
    ["singleton", "a -> Set a"],
    ["fromList", "Ord a => [a] -> Set a"],
    ["toList", "Set a -> [a]"],
    ["insert", "Ord a => a -> Set a -> Set a"],
    ["delete", "Ord a => a -> Set a -> Set a"],
    ["member", "Ord a => a -> Set a -> Bool"],
    ["notMember", "Ord a => a -> Set a -> Bool"],
    ["union", "Ord a => Set a -> Set a -> Set a"],
    ["unions", "(Foldable f, Ord a) => f (Set a) -> Set a"],
    ["intersection", "Ord a => Set a -> Set a -> Set a"],
    ["difference", "Ord a => Set a -> Set a -> Set a"],
    ["size", "Set a -> Int"],
    ["null", "Set a -> Bool"],
    ["filter", "(a -> Bool) -> Set a -> Set a"],
    ["map", "Ord b => (a -> b) -> Set a -> Set b"],
    ["findMin", "Set a -> a"],
    ["findMax", "Set a -> a"],
    ["minView", "Set a -> Maybe (a, Set a)"],
    ["maxView", "Set a -> Maybe (a, Set a)"],
  ],
  "Data.IntMap": [
    ["empty", "IntMap a"],
    ["singleton", "Int -> a -> IntMap a"],
    ["fromList", "[(Int, a)] -> IntMap a"],
    ["fromListWith", "(a -> a -> a) -> [(Int, a)] -> IntMap a"],
    ["toList", "IntMap a -> [(Int, a)]"],
    ["insert", "Int -> a -> IntMap a -> IntMap a"],
    ["insertWith", "(a -> a -> a) -> Int -> a -> IntMap a -> IntMap a"],
    ["delete", "Int -> IntMap a -> IntMap a"],
    ["lookup", "Int -> IntMap a -> Maybe a"],
    ["findWithDefault", "a -> Int -> IntMap a -> a"],
    ["member", "Int -> IntMap a -> Bool"],
    ["size", "IntMap a -> Int"],
    ["null", "IntMap a -> Bool"],
  ],
  "Data.IntSet": [
    ["empty", "IntSet"],
    ["singleton", "Int -> IntSet"],
    ["fromList", "[Int] -> IntSet"],
    ["toList", "IntSet -> [Int]"],
    ["insert", "Int -> IntSet -> IntSet"],
    ["delete", "Int -> IntSet -> IntSet"],
    ["member", "Int -> IntSet -> Bool"],
    ["union", "IntSet -> IntSet -> IntSet"],
    ["intersection", "IntSet -> IntSet -> IntSet"],
    ["difference", "IntSet -> IntSet -> IntSet"],
    ["size", "IntSet -> Int"],
    ["null", "IntSet -> Bool"],
  ],
  "Data.Sequence": [
    ["empty", "Seq a"],
    ["singleton", "a -> Seq a"],
    ["fromList", "[a] -> Seq a"],
    ["index", "Seq a -> Int -> a"],
    ["lookup", "Int -> Seq a -> Maybe a"],
    ["length", "Seq a -> Int"],
    ["null", "Seq a -> Bool"],
    ["viewl", "Seq a -> ViewL a"],
    ["viewr", "Seq a -> ViewR a"],
  ],
  "Data.Array": [
    ["array", "Ix i => (i, i) -> [(i, e)] -> Array i e"],
    ["listArray", "Ix i => (i, i) -> [e] -> Array i e"],
    ["bounds", "Ix i => Array i e -> (i, i)"],
    ["indices", "Ix i => Array i e -> [i]"],
    ["elems", "Ix i => Array i e -> [e]"],
    ["assocs", "Ix i => Array i e -> [(i, e)]"],
    ["inRange", "Ix i => (i, i) -> i -> Bool"],
    ["range", "Ix i => (i, i) -> [i]"],
  ],
  "Data.Text": [
    ["pack", "String -> Text"],
    ["unpack", "Text -> String"],
    ["empty", "Text"],
    ["null", "Text -> Bool"],
    ["length", "Text -> Int"],
    ["lines", "Text -> [Text]"],
    ["unlines", "[Text] -> Text"],
    ["words", "Text -> [Text]"],
    ["unwords", "[Text] -> Text"],
    ["splitOn", "Text -> Text -> [Text]"],
    ["strip", "Text -> Text"],
    ["stripPrefix", "Text -> Text -> Maybe Text"],
    ["stripSuffix", "Text -> Text -> Maybe Text"],
    ["isPrefixOf", "Text -> Text -> Bool"],
    ["isSuffixOf", "Text -> Text -> Bool"],
    ["isInfixOf", "Text -> Text -> Bool"],
    ["replace", "Text -> Text -> Text -> Text"],
    ["intercalate", "Text -> [Text] -> Text"],
    ["concat", "[Text] -> Text"],
    ["take", "Int -> Text -> Text"],
    ["drop", "Int -> Text -> Text"],
    ["filter", "(Char -> Bool) -> Text -> Text"],
    ["map", "(Char -> Char) -> Text -> Text"],
    ["reverse", "Text -> Text"],
  ],
  "Data.Text.IO": [
    ["getContents", "IO Text"],
    ["getLine", "IO Text"],
    ["putStr", "Text -> IO ()"],
    ["putStrLn", "Text -> IO ()"],
    ["readFile", "FilePath -> IO Text"],
  ],
  "Data.ByteString.Char8": [
    ["pack", "String -> ByteString"],
    ["unpack", "ByteString -> String"],
    ["lines", "ByteString -> [ByteString]"],
    ["words", "ByteString -> [ByteString]"],
    ["readInt", "ByteString -> Maybe (Int, ByteString)"],
    ["readInteger", "ByteString -> Maybe (Integer, ByteString)"],
    ["getContents", "IO ByteString"],
    ["getLine", "IO ByteString"],
    ["putStrLn", "ByteString -> IO ()"],
    ["length", "ByteString -> Int"],
    ["null", "ByteString -> Bool"],
    ["index", "ByteString -> Int -> Char"],
  ],
  "Control.Monad.State": [
    ["get", "MonadState s m => m s"],
    ["gets", "MonadState s m => (s -> a) -> m a"],
    ["put", "MonadState s m => s -> m ()"],
    ["modify", "MonadState s m => (s -> s) -> m ()"],
    ["modify'", "MonadState s m => (s -> s) -> m ()"],
    ["runState", "State s a -> s -> (a, s)"],
    ["evalState", "State s a -> s -> a"],
    ["execState", "State s a -> s -> s"],
  ],
  "Control.DeepSeq": [
    ["deepseq", "NFData a => a -> b -> b"],
    ["force", "NFData a => a -> a"],
    ["rnf", "NFData a => a -> ()"],
  ],
};

function moduleSymbols(modName: string): readonly [string, string, string?][] {
  if (modName === "Data.Map.Strict" || modName === "Data.Map.Lazy") {
    return MODULE_SYMBOLS["Data.Map"] ?? [];
  }
  if (modName === "Data.IntMap.Strict" || modName === "Data.IntMap.Lazy") {
    return MODULE_SYMBOLS["Data.IntMap"] ?? [];
  }
  if (modName === "Control.Monad.State.Strict" || modName === "Control.Monad.State.Lazy") {
    return MODULE_SYMBOLS["Control.Monad.State"] ?? [];
  }
  if (modName === "Data.ByteString") {
    return MODULE_SYMBOLS["Data.ByteString.Char8"] ?? [];
  }
  return MODULE_SYMBOLS[modName] ?? [];
}

/** Parses top-level `import` declarations from a Haskell source file. */
export function parseImports(source: string): ParsedImport[] {
  const imports: ParsedImport[] = [];
  const re =
    /^import\s+(?:(qualified)\s+)?([A-Z][A-Za-z0-9_.]*)(?:\s+(qualified))?(?:\s+as\s+([A-Z][A-Za-z0-9_.]*))?(?:\s+(hiding)\s*\(([^)]*)\)|\s*\(([^)]*)\))?/gm;
  for (const m of source.matchAll(re)) {
    const mod = m[2];
    if (!mod) continue;
    const qualified = Boolean(m[1] || m[3]);
    const alias = m[4] ?? null;
    const parseList = (raw: string | undefined): Set<string> | null => {
      if (raw === undefined) return null;
      const items = raw
        .split(",")
        .map((s) => s.replace(/\(.*\)/, "").trim())
        .filter(Boolean);
      return new Set(items);
    };
    imports.push({
      module: mod,
      qualified,
      alias,
      only: parseList(m[7]),
      hiding: m[5] ? parseList(m[6]) : null,
    });
  }
  return imports;
}

/** Extracts top-level value type signatures (`foo :: ...`) and type declarations from Haskell source. */
export function extractLocalSymbols(source: string, moduleName: string): SymbolEntry[] {
  const entries: SymbolEntry[] = [];
  const seen = new Set<string>();
  const lines = source.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const sigMatch = line.match(/^([a-z_][A-Za-z0-9_']*)\s*::\s*(.*)$/);
    if (sigMatch?.[1]) {
      const name = sigMatch[1];
      let sig = (sigMatch[2] ?? "").trim();
      // Fold indented continuation lines of a multi-line signature.
      while (i + 1 < lines.length) {
        const next = lines[i + 1] ?? "";
        if (/^\s+\S/.test(next) && !/^\s*--/.test(next)) {
          sig += ` ${next.trim()}`;
          i++;
        } else {
          break;
        }
      }
      if (!seen.has(name)) {
        seen.add(name);
        entries.push({
          name,
          signature: sig.replace(/\s+/g, " ").trim(),
          module: moduleName,
          kind: 3,
        });
      }
      continue;
    }

    const typeMatch = line.match(/^(?:data|newtype|type)\s+([A-Z][A-Za-z0-9_']*)\b(.*)$/);
    if (typeMatch?.[1] && !seen.has(typeMatch[1])) {
      seen.add(typeMatch[1]);
      entries.push({
        name: typeMatch[1],
        signature: line.trim(),
        module: moduleName,
        kind: 7,
      });
    }
  }

  return entries;
}

function collectScopeSymbols(
  source: string,
  helpersText: string | null,
  inferredSignatures: ReadonlyMap<string, string>,
): { unqualified: SymbolEntry[]; qualifiedByPrefix: Map<string, SymbolEntry[]> } {
  const imports = parseImports(source);
  const unqualified: SymbolEntry[] = [];
  const qualifiedByPrefix = new Map<string, SymbolEntry[]>();

  const addQualified = (prefix: string, entry: SymbolEntry) => {
    let list = qualifiedByPrefix.get(prefix);
    if (!list) {
      list = [];
      qualifiedByPrefix.set(prefix, list);
    }
    list.push(entry);
  };

  // Local declarations in the open file.
  const localSyms = extractLocalSymbols(source, "Main");
  const localNames = new Set(localSyms.map((s) => s.name));
  unqualified.push(...localSyms);

  // Inferred signatures from GHC `-Wmissing-signatures` for unannotated local bindings.
  for (const [name, signature] of inferredSignatures) {
    if (!localNames.has(name)) {
      localNames.add(name);
      unqualified.push({ name, signature, module: "Main", kind: 3 });
    }
  }

  // Helper module (e.g. `lib/Aoc.hs`) symbols, indexed by its module name.
  const helperModMatch = helpersText?.match(/^module\s+([A-Z][A-Za-z0-9_.]*)/m);
  const helperModName = helperModMatch?.[1] ?? "Aoc";
  const helperSyms = helpersText ? extractLocalSymbols(helpersText, helperModName) : [];

  const preludeImport = imports.find((imp) => imp.module === "Prelude");
  const implicitPrelude = !preludeImport && !/NoImplicitPrelude/.test(source);
  const effectiveImports: ParsedImport[] = implicitPrelude
    ? [{ module: "Prelude", qualified: false, alias: null, only: null, hiding: null }, ...imports]
    : imports;

  for (const imp of effectiveImports) {
    const raw: SymbolEntry[] =
      imp.module === helperModName
        ? helperSyms
        : moduleSymbols(imp.module).map(([name, signature, doc]) => ({
            name,
            signature,
            module: imp.module,
            kind: 3,
            doc,
          }));

    const visible = raw.filter((sym) => {
      if (imp.only && !imp.only.has(sym.name)) return false;
      if (imp.hiding?.has(sym.name)) return false;
      return true;
    });

    const prefix = imp.alias ?? imp.module;
    for (const sym of visible) {
      addQualified(prefix, sym);
      if (!imp.qualified) {
        unqualified.push(sym);
      }
    }
  }

  return { unqualified, qualifiedByPrefix };
}

function identifierAt(
  source: string,
  line: number,
  character: number,
): { qualifier: string | null; name: string } | null {
  const lines = source.split(/\r?\n/);
  const text = lines[line] ?? "";
  const isIdentChar = (c: string | undefined) => c !== undefined && /[A-Za-z0-9_'.]/.test(c);

  let start = Math.min(character, text.length);
  while (start > 0 && isIdentChar(text[start - 1])) start--;
  let end = Math.min(character, text.length);
  while (end < text.length && isIdentChar(text[end])) end++;

  const token = text.slice(start, end).replace(/^\.+|\.+$/g, "");
  if (!token) return null;
  const lastDot = token.lastIndexOf(".");
  if (lastDot !== -1) {
    return { qualifier: token.slice(0, lastDot), name: token.slice(lastDot + 1) };
  }
  return { qualifier: null, name: token };
}

export function provideHover(
  source: string,
  line: number,
  character: number,
  helpersText: string | null,
  inferredSignatures: ReadonlyMap<string, string>,
): { contents: { kind: "markdown"; value: string } } | null {
  const ident = identifierAt(source, line, character);
  if (!ident?.name) return null;
  const { unqualified, qualifiedByPrefix } = collectScopeSymbols(
    source,
    helpersText,
    inferredSignatures,
  );
  const candidates = ident.qualifier ? (qualifiedByPrefix.get(ident.qualifier) ?? []) : unqualified;
  const hit = candidates.find((s) => s.name === ident.name);
  if (!hit) return null;

  const decl = hit.kind === 7 ? hit.signature : `${hit.name} :: ${hit.signature}`;
  const docPart = hit.doc ? `\n\n${hit.doc}` : "";
  const modPart = `\n\n*Defined in \`${hit.module}\`*`;
  return {
    contents: {
      kind: "markdown",
      value: `\`\`\`haskell\n${decl}\n\`\`\`${docPart}${modPart}`,
    },
  };
}

export function provideCompletions(
  source: string,
  line: number,
  character: number,
  helpersText: string | null,
  inferredSignatures: ReadonlyMap<string, string>,
): { label: string; kind: number; detail: string; documentation?: string | undefined }[] {
  const lines = source.split(/\r?\n/);
  const before = (lines[line] ?? "").slice(0, character);
  const tokenMatch = before.match(/([A-Za-z0-9_'.]*)$/);
  const token = tokenMatch?.[1] ?? "";

  const { unqualified, qualifiedByPrefix } = collectScopeSymbols(
    source,
    helpersText,
    inferredSignatures,
  );

  const lastDot = token.lastIndexOf(".");
  let candidates: SymbolEntry[];
  let prefix: string;

  if (lastDot !== -1) {
    const qualifier = token.slice(0, lastDot);
    prefix = token.slice(lastDot + 1);
    candidates = qualifiedByPrefix.get(qualifier) ?? [];
  } else {
    prefix = token;
    candidates = unqualified;
  }

  const lowerPrefix = prefix.toLowerCase();
  const seen = new Set<string>();
  const items: {
    label: string;
    kind: number;
    detail: string;
    documentation?: string | undefined;
  }[] = [];

  for (const sym of candidates) {
    if (seen.has(sym.name)) continue;
    if (lowerPrefix && !sym.name.toLowerCase().startsWith(lowerPrefix)) continue;
    seen.add(sym.name);
    items.push({
      label: sym.name,
      kind: sym.kind,
      detail: sym.kind === 7 ? sym.signature : sym.signature,
      ...(sym.doc
        ? { documentation: `${sym.doc} (${sym.module})` }
        : { documentation: sym.module }),
    });
  }

  return items.slice(0, 60);
}

export function provideSignatureHelp(
  source: string,
  line: number,
  character: number,
  helpersText: string | null,
  inferredSignatures: ReadonlyMap<string, string>,
): {
  signatures: { label: string; documentation?: string | undefined }[];
  activeSignature: number;
} | null {
  const lines = source.split(/\r?\n/);
  const before = (lines[line] ?? "").slice(0, character).trimEnd();
  // Find the nearest identifier token before the cursor (e.g. `M.insertWith ` or `foldl' (`).
  const match = before.match(/([A-Z][A-Za-z0-9_.]*\.)?([a-z_][A-Za-z0-9_']*)\s*[\s(]*$/);
  if (!match?.[2]) return null;
  const qualifier = match[1] ? match[1].slice(0, -1) : null;
  const name = match[2];

  const { unqualified, qualifiedByPrefix } = collectScopeSymbols(
    source,
    helpersText,
    inferredSignatures,
  );
  const candidates = qualifier ? (qualifiedByPrefix.get(qualifier) ?? []) : unqualified;
  const hit = candidates.find((s) => s.name === name && s.kind !== 7);
  if (!hit) return null;

  return {
    signatures: [
      {
        label: `${hit.name} :: ${hit.signature}`,
        ...(hit.doc ? { documentation: hit.doc } : {}),
      },
    ],
    activeSignature: 0,
  };
}
