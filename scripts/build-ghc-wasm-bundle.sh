#!/usr/bin/env bash
# Reproducibly builds a custom 10-package GHC WASM on-device bundle (rootfs.tar.zst + bsdtar.wasm)
# for Workshop by layering Workshop's missing default Haskell packages (`unordered-containers`,
# `split`, `parsec`) onto the pinned upstream `haskell-wasm/ghc-in-browser` rootfs and fixing
# `system-cxx-std-lib-1.0.conf` to point at `/tmp/clib`.
#
# Intended for Linux x86_64 (CI `ubuntu-latest` or Docker) where `ghc-wasm-meta` installs the
# exact matching `wasm32-wasi-ghc` / `wasm32-wasi-cabal` ABI.
#
# Usage: scripts/build-ghc-wasm-bundle.sh <out-dir> [version]
set -euo pipefail

if [ "$#" -lt 1 ]; then
  echo "Usage: $0 <out-dir> [version]" >&2
  exit 1
fi

OUT_DIR="$(mkdir -p "$1" && cd "$1" && pwd)"
VERSION="${2:-9.14.0-workshop.1}"

UPSTREAM_BASE="https://haskell-wasm.github.io/ghc-in-browser"
UPSTREAM_BSDTAR_SHA256="e13ebb15ca0971f6629a6313bc043c532dd9be3a0e6bb0b7f8a395de835ad0c0"
UPSTREAM_ROOTFS_SHA256="35f68f56fdb72111f150ba05ad31efed2f6fc77ee7026fb4b197ae7901a67adf"

EXTRA_PACKAGES=(
  "unordered-containers"
  "split"
  "parsec"
)

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

echo "==> Downloading pinned upstream GHC WASM artifacts"
curl -fsSL "$UPSTREAM_BASE/bsdtar.wasm" -o "$OUT_DIR/bsdtar.wasm"
verify_sha256 "$OUT_DIR/bsdtar.wasm" "$UPSTREAM_BSDTAR_SHA256"

curl -fsSL "$UPSTREAM_BASE/rootfs.tar.zst" -o "$WORK/upstream-rootfs.tar.zst"
verify_sha256 "$WORK/upstream-rootfs.tar.zst" "$UPSTREAM_ROOTFS_SHA256"

echo "==> Extracting upstream rootfs"
mkdir -p "$WORK/rootfs"
zstd -dc "$WORK/upstream-rootfs.tar.zst" | tar -xf - -C "$WORK/rootfs"

GHC_LIBDIR="$WORK/rootfs/tmp/hslib/lib"
PKG_DB="$GHC_LIBDIR/package.conf.d"

# Point system-cxx-std-lib at `/tmp/clib` (where libc++.so and libc++abi.so live in the VFS)
# instead of the build host's `/workspace/.ghc-wasm/...` path.
if [ -f "$PKG_DB/system-cxx-std-lib-1.0.conf" ]; then
  sed -i 's|/workspace/.ghc-wasm/wasi-sdk/bin/../share/wasi-sysroot/lib/wasm32-wasi|/tmp/clib|g' \
    "$PKG_DB/system-cxx-std-lib-1.0.conf"
fi

if ! command -v wasm32-wasi-cabal >/dev/null 2>&1 || ! command -v wasm32-wasi-ghc-pkg >/dev/null 2>&1; then
  echo "error: wasm32-wasi-cabal and wasm32-wasi-ghc-pkg must be on PATH (install via ghc-wasm-meta)" >&2
  exit 1
fi

echo "==> Verifying GHC WASM ABI compatibility"
HOST_GHC_VER="$(wasm32-wasi-ghc --numeric-version)"
ROOTFS_GHC_DIR="$(basename "$(find "$GHC_LIBDIR" -maxdepth 1 -type d -name 'wasm32-wasi-ghc-*' | head -n 1)")"
ROOTFS_GHC_VER="${ROOTFS_GHC_DIR#wasm32-wasi-ghc-}"
ROOTFS_GHC_VER="${ROOTFS_GHC_VER%-inplace}"
if [ "$HOST_GHC_VER" != "$ROOTFS_GHC_VER" ]; then
  echo "error: wasm32-wasi-ghc version ($HOST_GHC_VER) must match rootfs ABI ($ROOTFS_GHC_VER)" >&2
  exit 1
fi

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
  --package-db=clear \
  --package-db="$PKG_DB" \
  --store-dir="$WORK/store" \
  --installdir="$WORK/install" \
  "${EXTRA_PACKAGES[@]}"

echo "==> Merging built shared libraries and package registrations into rootfs"
STORE_GHC_DIR="$(find "$WORK/store" -maxdepth 1 -type d -name 'ghc-*' | head -n 1)"
if [ -z "$STORE_GHC_DIR" ]; then
  echo "error: no store directory found under $WORK/store" >&2
  exit 1
fi

TARGET_LIB_DIR="$GHC_LIBDIR/$ROOTFS_GHC_DIR"
find "$STORE_GHC_DIR" -name '*.so' -exec cp -a {} "$TARGET_LIB_DIR/" \;

for conf in "$STORE_GHC_DIR"/package.db/*.conf; do
  [ -e "$conf" ] || continue
  cp "$conf" "$PKG_DB/"
done

# Copy .hi interface files for the newly built packages into the rootfs layout and recache.
for pkg_dir in "$STORE_GHC_DIR"/*; do
  base="$(basename "$pkg_dir")"
  case "$base" in
    package.db|incoming) continue ;;
  esac
  if [ -d "$pkg_dir/lib" ]; then
    mkdir -p "$TARGET_LIB_DIR/$base"
    cp -a "$pkg_dir/lib/." "$TARGET_LIB_DIR/$base/"
  fi
done

# Rewrite absolute store paths inside newly copied .conf files to ${pkgroot}-relative paths.
for conf in "$PKG_DB"/*.conf; do
  sed -i "s|$STORE_GHC_DIR|\${pkgroot}/../$ROOTFS_GHC_DIR|g" "$conf"
done

wasm32-wasi-ghc-pkg --package-db="$PKG_DB" recache

echo "==> Packing reproducible rootfs.tar.zst"
(
  cd "$WORK/rootfs"
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
  "ghc_libdir": "/tmp/hslib/lib",
  "ghc_lib_search_dir": "/tmp/hslib/lib/$ROOTFS_GHC_DIR",
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
