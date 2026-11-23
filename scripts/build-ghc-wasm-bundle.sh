#!/usr/bin/env bash
# Reproducibly builds Workshop's full 10-package GHC 9.14 WASM on-device bundle
# (`bsdtar.wasm`, `rootfs.tar.zst`, `SHA256SUMS`, `bundle-manifest.json`) directly from the
# installed `ghc-wasm-meta` toolchain (`wasm32-wasi-ghc`, `wasm32-wasi-cabal`, `wasi-sdk`).
#
# Building the entire rootfs from the installed `wasm32-wasi-ghc` guarantees exact GHC ABI parity
# between the base libraries, the `ghc` API library (`libHSghc-*.so`), `libplayground001.so`, and
# Workshop's extra packages (`unordered-containers`, `split`, `parsec`).
#
# Intended for Linux x86_64 (CI `ubuntu-latest` or Docker) with `ghc-wasm-meta` installed.
#
# Usage: scripts/build-ghc-wasm-bundle.sh <out-dir> [version]
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <out-dir> [version]" >&2
  exit 1
fi

OUT_DIR="$(mkdir -p "$1" && cd "$1" && pwd)"
VERSION="${2:-9.14.0-workshop.1}"

UPSTREAM_BSDTAR_URL="https://haskell-wasm.github.io/ghc-in-browser/bsdtar.wasm"
UPSTREAM_BSDTAR_SHA256="e13ebb15ca0971f6629a6313bc043c532dd9be3a0e6bb0b7f8a395de835ad0c0"

EXTRA_PACKAGES=(
  "unordered-containers"
  "split"
  "parsec"
)

if ! command -v wasm32-wasi-ghc >/dev/null 2>&1 || ! command -v wasm32-wasi-cabal >/dev/null 2>&1 || ! command -v wasm32-wasi-ghc-pkg >/dev/null 2>&1; then
  echo "error: wasm32-wasi-ghc, wasm32-wasi-cabal, and wasm32-wasi-ghc-pkg must be on PATH (install via ghc-wasm-meta)" >&2
  exit 1
fi

GHC_WASM_PREFIX="${GHC_WASM_PREFIX:-$HOME/.ghc-wasm}"
WASI_LIB_DIR="$GHC_WASM_PREFIX/wasi-sdk/share/wasi-sysroot/lib/wasm32-wasi"
if [ ! -d "$WASI_LIB_DIR" ]; then
  echo "error: WASI sysroot lib dir not found at $WASI_LIB_DIR" >&2
  exit 1
fi

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

verify_sha256() {
  local file="$1"
  local expected="$2"
  local actual
  actual="$(sha256sum "$file" | awk '{print $1}')"
  if [ "$actual" != "$expected" ]; then
    echo "SHA-256 mismatch for $file: expected $expected, got $actual" >&2
    exit 1
  fi
}

echo "==> Downloading pinned bsdtar.wasm"
curl -fsSL "$UPSTREAM_BSDTAR_URL" -o "$OUT_DIR/bsdtar.wasm"
verify_sha256 "$OUT_DIR/bsdtar.wasm" "$UPSTREAM_BSDTAR_SHA256"

SRC_LIBDIR="$(wasm32-wasi-ghc --print-libdir)"
GHC_VER="$(wasm32-wasi-ghc --numeric-version)"
GHC_LIB_SUBDIR="$(basename "$(find "$SRC_LIBDIR" -maxdepth 1 -type d -name 'wasm32-wasi-ghc-*' | head -n 1)")"
if [ -z "$GHC_LIB_SUBDIR" ]; then
  echo "error: could not find wasm32-wasi-ghc-* directory inside $SRC_LIBDIR" >&2
  exit 1
fi
echo "==> Building rootfs for wasm32-wasi-ghc $GHC_VER ($GHC_LIB_SUBDIR)"

ROOTFS="$WORK/rootfs"
CLIB="$ROOTFS/tmp/clib"
HSLIB="$ROOTFS/tmp/hslib/lib"
TARGET_LIB_DIR="$HSLIB/$GHC_LIB_SUBDIR"
PKG_DB="$HSLIB/package.conf.d"
mkdir -p "$CLIB" "$TARGET_LIB_DIR" "$PKG_DB"

echo "==> Copying WASI C/C++/FFI shared libraries into /tmp/clib"
for lib in libc.so libc++.so libc++abi.so libdl.so libffi.so; do
  if [ -e "$WASI_LIB_DIR/$lib" ]; then
    cp -L "$WASI_LIB_DIR/$lib" "$CLIB/$lib"
  fi
done

echo "==> Copying GHC metadata and dynamic libraries/interfaces into /tmp/hslib/lib"
for meta in settings llvm-passes llvm-targets template-hsc.h; do
  if [ -e "$SRC_LIBDIR/$meta" ]; then
    cp -a "$SRC_LIBDIR/$meta" "$HSLIB/"
  fi
done
cp -a "$SRC_LIBDIR/package.conf.d/." "$PKG_DB/"

# Copy only shared libraries (.so), dynamic interface files (.dyn_hi), and headers (.h)
# to keep the compressed bundle compact (~50 MB) while supporting full GHCi bytecode loading.
(
  cd "$SRC_LIBDIR/$GHC_LIB_SUBDIR"
  find . -type f \( -name '*.so' -o -name '*.dyn_hi' -o -name '*.h' \) \
    ! -name '*_thr*' ! -name '*_debug*' ! -name '*_p*' \
    -print0 \
    | tar --null -T - -cf - \
    | tar -xf - -C "$TARGET_LIB_DIR"
)

# Point system-cxx-std-lib at `/tmp/clib` inside the in-browser VFS.
for conf in "$PKG_DB"/system-cxx-std-lib-*.conf; do
  [ -e "$conf" ] || continue
  sed -i -E 's|library-dirs:.*|library-dirs: /tmp/clib|g; s|dynamic-library-dirs:.*|dynamic-library-dirs: /tmp/clib|g' "$conf"
done

echo "==> Building /tmp/libplayground001.so GHC API driver"
cat >"$WORK/Playground.hs" <<'EOF'
{-# LANGUAGE ForeignFunctionInterface #-}
{-# LANGUAGE ScopedTypeVariables #-}
module Playground where

import Control.Exception (SomeException, try)
import Control.Monad (void, when)
import Control.Monad.IO.Class (liftIO)
import Data.IORef (newIORef)
import GHC
  ( GhcLink (LinkInMemory),
    GhcMode (CompManager),
    InteractiveImport (IIModule),
    LoadHowMuch (LoadAllTargets),
    SuccessFlag (Failed),
    compileExprRemote,
    defaultErrorHandler,
    getSession,
    getSessionDynFlags,
    guessTarget,
    handleSourceError,
    initGhcMonad,
    load,
    mkModuleName,
    noLoc,
    parseDynamicFlags,
    printException,
    setContext,
    setSessionDynFlags,
    setTargets,
  )
import GHC.Driver.Backend (backendGeneratesCode, interpreterBackend)
import GHC.Driver.DynFlags
  ( DynFlags (backend, ghcLink, ghcMode),
    defaultFatalMessager,
    defaultFlushOut,
  )
import GHC.Driver.Env (hscInterp)
import GHC.Driver.Monad (Ghc (unGhc), Session (Session))
import GHC.Runtime.Interpreter (evalIO)
import GHC.Wasm.Prim (JSString, JSVal, fromJSString)
import System.IO (IOMode (WriteMode), hFlush, hPutStr, hSetEncoding, stderr, stdout, utf8, withFile)

foreign import javascript "wrapper"
  mkRunPlayground :: (JSString -> JSString -> IO ()) -> IO JSVal

foreign export javascript "myMain"
  myMain :: JSString -> IO JSVal

myMain :: JSString -> IO JSVal
myMain libdirJs = do
  let libdir = fromJSString libdirJs
  sessionRef <- newIORef (error "uninitialized GHC session")
  let session = Session sessionRef
  baseDflags <-
    unGhc
      ( do
          initGhcMonad (Just libdir)
          d0 <- getSessionDynFlags
          let d1 =
                d0
                  { ghcMode = CompManager,
                    ghcLink = LinkInMemory,
                    backend = interpreterBackend
                  }
          _ <- setSessionDynFlags d1
          pure d1
      )
      session
  mkRunPlayground $ \flagsJs codeJs -> do
    let flagsStr = fromJSString flagsJs
        codeStr = fromJSString codeJs
    withFile "/tmp/Main.hs" WriteMode $ \h -> do
      hSetEncoding h utf8
      hPutStr h codeStr
    let action =
          handleSourceError
            ( \se -> do
                printException se
                liftIO $ hFlush stderr
                liftIO $ ioError (userError "load returned Failed")
            )
            $ do
              (dflags, _, _) <- parseDynamicFlags baseDflags (map noLoc (words flagsStr))
              _ <- setSessionDynFlags dflags
              setTargets []
              void $ load LoadAllTargets
              target <- guessTarget "/tmp/Main.hs" Nothing Nothing
              setTargets [target]
              ok <- load LoadAllTargets
              case ok of
                Failed -> liftIO $ do
                  hFlush stderr
                  ioError (userError "load returned Failed")
                _ ->
                  when (backendGeneratesCode (backend dflags)) $ do
                    setContext [IIModule (mkModuleName "Main")]
                    hval <- compileExprRemote "Main.main"
                    env <- getSession
                    res <- liftIO $ try (evalIO (hscInterp env) hval)
                    liftIO $ hFlush stdout >> hFlush stderr
                    case res of
                      Left (err :: SomeException) -> liftIO $ ioError (userError (show err))
                      Right () -> pure ()
    defaultErrorHandler defaultFatalMessager defaultFlushOut $ unGhc action session
EOF

wasm32-wasi-ghc \
  -shared -dynamic -fPIC -O \
  -package ghc \
  -outputdir "$WORK/pg-build" \
  -o "$ROOTFS/tmp/libplayground001.so" \
  "$WORK/Playground.hs"

echo "==> Cross-compiling extra Workshop packages: ${EXTRA_PACKAGES[*]}"
wasm32-wasi-cabal update
mkdir -p "$WORK/build"
cat >"$WORK/build/cabal.project" <<'EOF'
packages: .
shared: True
library-for-ghci: False
package *
  ghc-options: -dynamic-too
  documentation: False
EOF

wasm32-wasi-cabal install \
  --project-dir="$WORK/build" \
  --lib \
  --store-dir="$WORK/store" \
  --installdir="$WORK/install" \
  "${EXTRA_PACKAGES[@]}"

echo "==> Merging built shared libraries and package registrations into rootfs"
STORE_GHC_DIR="$(find "$WORK/store" -maxdepth 1 -type d -name 'ghc-*' | head -n 1)"
if [ -z "$STORE_GHC_DIR" ]; then
  echo "error: no store directory found under $WORK/store" >&2
  exit 1
fi

# Copy every built .so into $TARGET_LIB_DIR so dyld.mjs finds them directly in searchDirs.
find "$STORE_GHC_DIR" -type f -name '*.so' -exec cp -L {} "$TARGET_LIB_DIR/" \;

# Copy package registrations and dynamic interfaces (.dyn_hi + .h) into the rootfs layout.
for conf in "$STORE_GHC_DIR"/package.db/*.conf; do
  [ -e "$conf" ] || continue
  cp "$conf" "$PKG_DB/"
done

for pkg_dir in "$STORE_GHC_DIR"/*; do
  base="$(basename "$pkg_dir")"
  case "$base" in
    package.db|incoming) continue ;;
  esac
  if [ -d "$pkg_dir/lib" ]; then
    mkdir -p "$TARGET_LIB_DIR/$base"
    (
      cd "$pkg_dir/lib"
      find . -type f \( -name '*.dyn_hi' -o -name '*.h' -o -name '*.so' \) -print0 \
        | tar --null -T - -cf - \
        | tar -xf - -C "$TARGET_LIB_DIR/$base"
    )
  fi
done

# Rewrite store paths in newly merged .conf files to ${pkgroot}-relative paths so in-browser GHC
# locates both .dyn_hi (import-dirs) and .so (dynamic-library-dirs) inside /tmp/hslib/lib.
for conf in "$PKG_DB"/*.conf; do
  [ -e "$conf" ] || continue
  sed -i \
    -e "s|$STORE_GHC_DIR/\([^/[:space:]]*\)/lib|\${pkgroot}/../$GHC_LIB_SUBDIR/\1|g" \
    -e "s|$STORE_GHC_DIR|\${pkgroot}/../$GHC_LIB_SUBDIR|g" \
    "$conf"
done

wasm32-wasi-ghc-pkg --package-db="$PKG_DB" recache

echo "==> Packing reproducible rootfs.tar.zst"
(
  cd "$ROOTFS"
  tar --sort=name --mtime='@0' --owner=0 --group=0 --numeric-owner -cf - . \
    | zstd -19 -T0 -o "$OUT_DIR/rootfs.tar.zst"
)

BSDTAR_SIZE="$(stat -c%s "$OUT_DIR/bsdtar.wasm" 2>/dev/null || stat -f%z "$OUT_DIR/bsdtar.wasm")"
BSDTAR_SHA="$(sha256sum "$OUT_DIR/bsdtar.wasm" | awk '{print $1}')"
ROOTFS_SIZE="$(stat -c%s "$OUT_DIR/rootfs.tar.zst" 2>/dev/null || stat -f%z "$OUT_DIR/rootfs.tar.zst")"
ROOTFS_SHA="$(sha256sum "$OUT_DIR/rootfs.tar.zst" | awk '{print $1}')"

cat >"$OUT_DIR/SHA256SUMS" <<EOF
$BSDTAR_SHA  bsdtar.wasm
$ROOTFS_SHA  rootfs.tar.zst
EOF

cat >"$OUT_DIR/bundle-manifest.json" <<EOF
{
  "id": "haskell-ghc-wasm",
  "version": "$VERSION",
  "language": "haskell",
  "engine": "GHC 9.14 WASM",
  "description": "GHC 9.14 compiler and bytecode runtime in WebAssembly with Workshop's default packages.",
  "packages": [
    "base",
    "containers",
    "unordered-containers",
    "array",
    "split",
    "parsec",
    "mtl",
    "transformers",
    "text",
    "bytestring",
    "deepseq",
    "stm",
    "binary",
    "time",
    "filepath",
    "directory"
  ],
  "ghc_libdir": "/tmp/hslib/lib",
  "ghc_lib_search_dir": "/tmp/hslib/lib/$GHC_LIB_SUBDIR",
  "main_so_path": "/tmp/libplayground001.so",
  "files": [
    {
      "name": "bsdtar.wasm",
      "size": $BSDTAR_SIZE,
      "sha256": "$BSDTAR_SHA",
      "content_type": "application/wasm"
    },
    {
      "name": "rootfs.tar.zst",
      "size": $ROOTFS_SIZE,
      "sha256": "$ROOTFS_SHA",
      "content_type": "application/zstd"
    }
  ]
}
EOF

echo "==> Built on-device bundle in $OUT_DIR:"
cat "$OUT_DIR/SHA256SUMS"
