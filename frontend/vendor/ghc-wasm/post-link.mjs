// This is the post-linker helper that parses ghc_wasm_jsffi custom sections
// for dyld.mjs (Node CLI stripped for browser/Worker bundling).

// Each record in the ghc_wasm_jsffi custom section are 3
// NUL-terminated strings: name, binder, body. We try to parse the
// body as an expression and fallback to statements, and return the
// completely parsed arrow function source.
export function parseRecord([name, binder, body]) {
  for (const src of [`${binder} => (${body})`, `${binder} => {${body}}`]) {
    try {
      new Function(`return ${src};`);
      return src;
    } catch (_) {}
  }
  throw new Error(`parseRecord ${name} ${binder} ${body}`);
}

// Parse ghc_wasm_jsffi custom sections in a WebAssembly.Module object
// and return an array of records.
export function parseSections(mod) {
  const recs = [];
  const dec = new TextDecoder("utf-8", { fatal: true });
  const importNames = new Set(
    WebAssembly.Module.imports(mod)
      .filter((i) => i.module === "ghc_wasm_jsffi")
      .map((i) => i.name)
  );
  for (const buf of WebAssembly.Module.customSections(mod, "ghc_wasm_jsffi")) {
    const ba = new Uint8Array(buf);
    let strs = [];
    for (let l = 0, r; l < ba.length; l = r + 1) {
      r = ba.indexOf(0, l);
      strs.push(dec.decode(ba.subarray(l, r)));
      if (strs.length === 3) {
        if (importNames.has(strs[0])) {
          recs.push(strs);
        }
        strs = [];
      }
    }
  }
  return recs;
}

// Note [Variable passing in JSFFI]
// ~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~~
//
// The JSFFI code snippets can access variables in globalThis,
// arguments like $1, $2, etc, plus a few magic variables: __exports,
// __ghc_wasm_jsffi_dyld and __ghc_wasm_jsffi_finalization_registry.
// How are these variables passed to JSFFI code? Remember, we strive
// to keep the globalThis namespace hygiene and maintain the ability
// to have multiple Haskell-wasm apps coexisting in the same JS
// context, so we must not pass magic variables as global variables
// even though they may seem globally unique.
//
// The solution is simple: put them in the JS lambda binder position.
// Though there are different layers of lambdas here:
//
// 1. User writes "$1($2, await $3)" in a JSFFI code snippet. No
//    explicit binder here, the snippet is either an expression or
//    some statements.
// 2. GHC doesn't know JS syntax but it knows JS function arity from
//    HS type signature, as well as if the JS function is async/sync
//    from safe/unsafe annotation. So it infers the JS binder (like
//    "async ($1, $2, $3)") and emits a (name,binder,body) tuple into
//    the ghc_wasm_jsffi custom section.
// 3. After link-time we collect these tuples to make a JS object
//    mapping names to binder=>body, and this JS object will be used
//    to fulfill the ghc_wasm_jsffi wasm imports. This JS object is
//    returned by an outer layer of lambda which is in charge of
//    passing magic variables.
//
// In case of post-linker for statically linked wasm modules,
// __ghc_wasm_jsffi_dyld won't work so is omitted, and
// __ghc_wasm_jsffi_finalization_registry can be created inside the
// outer JS lambda. Only __exports is exposed as user-visible API
// since it's up to the user to perform knot-tying by assigning the
// instance exports back to the (initially empty) __exports object
// passed to this lambda.
//
// In case of dyld, all magic variables are dyld-session-global
// variables; dyld uses new Function() to make the outer lambda, then
// immediately invokes it by passing the right magic variables.
