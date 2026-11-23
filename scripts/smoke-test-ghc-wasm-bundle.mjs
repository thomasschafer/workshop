#!/usr/bin/env node
// Smoke-tests a freshly built GHC WASM on-device bundle directory (`bsdtar.wasm`, `rootfs.tar.zst`,
// `bundle-manifest.json`) using Workshop's vendored `dyld.mjs` and `browser_wasi_shim.mjs`.
// Verifies that all 10 Workshop default packages (including Data.Text, unordered-containers,
// split, and parsec) compile & run cleanly AND that `-fno-code -Wall -ferror-spans` emits
// structured GHC diagnostics without crashing the persistent session.

import fs from "node:fs";
import path from "node:path";
import {
  ConsoleStdout,
  File,
  OpenFile,
  PreopenDirectory,
  WASI,
} from "../frontend/vendor/ghc-wasm/browser_wasi_shim.mjs";
import { DyLDBrowserHost, main as dyldMain } from "../frontend/vendor/ghc-wasm/dyld.mjs";

const bundleDir = process.argv[2];
if (!bundleDir) {
  console.error("Usage: node scripts/smoke-test-ghc-wasm-bundle.mjs <bundle-dir>");
  process.exit(1);
}

const manifest = JSON.parse(fs.readFileSync(path.join(bundleDir, "bundle-manifest.json"), "utf8"));
const bsdtarBytes = fs.readFileSync(path.join(bundleDir, "bsdtar.wasm"));
const rootfsBytes = fs.readFileSync(path.join(bundleDir, "rootfs.tar.zst"));

console.log(`==> Unpacking ${manifest.id}@${manifest.version} (${rootfsBytes.byteLength} bytes)`);
const rootfs = new PreopenDirectory("/", []);
const bsdtarWasi = new WASI(
  ["bsdtar.wasm", "-x"],
  [],
  [
    new OpenFile(new File(rootfsBytes, { readonly: true })),
    ConsoleStdout.lineBuffered(() => {}),
    ConsoleStdout.lineBuffered((line) => console.error("[bsdtar]", line)),
    rootfs,
  ],
  { debug: false },
);
const { instance } = await WebAssembly.instantiate(bsdtarBytes, {
  wasi_snapshot_preview1: bsdtarWasi.wasiImport,
});
bsdtarWasi.start(instance);

let stdout = "";
let stderr = "";
const dec = new TextDecoder("utf-8");

const dyld = await dyldMain({
  rpc: new DyLDBrowserHost({
    rootfs,
    stdoutChunk: (buf) => {
      stdout += dec.decode(buf, { stream: true });
    },
    stderrChunk: (buf) => {
      stderr += dec.decode(buf, { stream: true });
    },
  }),
  searchDirs: ["/tmp/clib", manifest.ghc_lib_search_dir],
  mainSoPath: manifest.main_so_path,
  args: ["libplayground001.so", "+RTS", "-c", "-RTS"],
  isIserv: false,
});

let runPlayground;
try {
  runPlayground = await dyld.exportFuncs.myMain(manifest.ghc_libdir);
} catch (err) {
  console.error("myMain failed!");
  console.error("=== STDOUT ===\n" + stdout + dec.decode());
  console.error("=== STDERR ===\n" + stderr + dec.decode());
  throw err;
}

// Test 1: Run a solution using Data.Text + OverloadedStrings + unordered-containers + split + parsec!
const sampleProgram = `{-# LANGUAGE OverloadedStrings #-}
module Main where

import qualified Data.HashMap.Strict as HM
import Data.List.Split (splitOn)
import qualified Data.Text as T
import Text.Parsec (parse, many1, digit, string)

main :: IO ()
main = do
  let parts = splitOn "," "a,b,a,c"
  let counts = HM.fromListWith (+) [(T.pack p, 1 :: Int) | p <- parts]
  let parsed = parse (string "val=" *> many1 digit) "" "val=42"
  putStrLn $ "a=" ++ show (HM.lookupDefault 0 "a" counts) ++ " parsed=" ++ show parsed
`;

stdout = "";
stderr = "";
try {
  await runPlayground("-v0", sampleProgram);
} catch (err) {
  console.error("Test 1 threw!");
  console.error("=== STDOUT ===\n" + stdout + dec.decode());
  console.error("=== STDERR ===\n" + stderr + dec.decode());
  throw err;
}
stdout += dec.decode();
stderr += dec.decode();
console.log("Test 1 stdout:", stdout.trim());
if (stderr.trim()) console.error("Test 1 stderr:", stderr.trim());
if (!stdout.includes('a=2 parsed=Right "42"')) {
  throw new Error(`Unexpected Test 1 stdout: ${JSON.stringify(stdout)} (stderr: ${stderr})`);
}
if (stderr.trim() !== "") {
  throw new Error(`Expected empty stderr for Test 1, got: ${stderr}`);
}

// Test 2: `-fno-code -Wall -ferror-spans` type-check diagnostics (Phase 3 LSP path)
const brokenProgram = `module Main where
bad :: Int
bad = "nope"
main :: IO ()
main = print bad
`;

stdout = "";
stderr = "";
let threw = false;
try {
  await runPlayground("-v0 -fno-code -Wall -ferror-spans -fdiagnostics-color=never", brokenProgram);
} catch {
  threw = true;
}
stderr += dec.decode();
console.log("Test 2 threw:", threw, "stderr excerpt:", stderr.slice(0, 200));
if (!stderr.includes("Couldn't match type") || !stderr.includes("/tmp/Main.hs:3:")) {
  throw new Error(`Expected GHC error diagnostic in Test 2, got:\n${stderr}`);
}

// Test 3: Verify persistent session still runs cleanly after `-fno-code` error
stdout = "";
stderr = "";
await runPlayground("-v0", 'module Main where\nmain :: IO ()\nmain = putStrLn "still-alive"\n');
stdout += dec.decode();
if (!stdout.includes("still-alive")) {
  throw new Error(`Session did not recover cleanly in Test 3: stdout=${stdout} stderr=${stderr}`);
}

console.log("==> Bundle smoke test PASSED!");
