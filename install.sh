#!/bin/sh
# Installs the latest release of Workshop: curl -fsSL https://raw.githubusercontent.com/thomasschafer/workshop/main/install.sh | sh
#
# It downloads the build for this system, checks it against its published checksum, and puts it in
# ~/.local/bin, or WORKSHOP_INSTALL_DIR if that's set. Run it again to update.
set -eu

repo="thomasschafer/workshop"
install_dir="${WORKSHOP_INSTALL_DIR:-$HOME/.local/bin}"

fail() {
  echo "workshop install: $*" >&2
  exit 1
}

case "$(uname -s)" in
  Darwin) os="apple-darwin" ;;
  Linux) os="unknown-linux-musl" ;;
  *) fail "there's no build for $(uname -s) here; see https://github.com/$repo/releases" ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) arch="x86_64" ;;
  arm64 | aarch64) arch="aarch64" ;;
  *) fail "there's no build for $(uname -m) processors" ;;
esac

# The latest release's tag, from where GitHub's "latest" link leads.
latest=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$repo/releases/latest")
tag="${latest##*/}"
case "$tag" in
  v[0-9]*) ;;
  *) fail "couldn't find the latest release" ;;
esac

name="workshop-$tag-$arch-$os"
url="https://github.com/$repo/releases/download/$tag/$name.tar.gz"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT

echo "Downloading Workshop ${tag} for ${arch}-${os}…"
curl -fsSL -o "$work/$name.tar.gz" "$url" || fail "couldn't download $url"
curl -fsSL -o "$work/$name.tar.gz.sha256" "$url.sha256" || fail "couldn't download its checksum"

expected=$(cut -d ' ' -f 1 < "$work/$name.tar.gz.sha256")
if command -v sha256sum > /dev/null; then
  actual=$(sha256sum "$work/$name.tar.gz" | cut -d ' ' -f 1)
else
  actual=$(shasum -a 256 "$work/$name.tar.gz" | cut -d ' ' -f 1)
fi
[ "$expected" = "$actual" ] || fail "the download doesn't match its checksum, so it wasn't installed"

tar -xzf "$work/$name.tar.gz" -C "$work"
mkdir -p "$install_dir"
install -m 755 "$work/$name/workshop" "$install_dir/workshop"
echo "Installed $("$install_dir/workshop" --version) to $install_dir."

case ":$PATH:" in
  *":$install_dir:"*) echo "Start it with \`workshop\`, and check your setup with \`workshop doctor\`." ;;
  *) echo "$install_dir isn't on your PATH yet: add it to your shell's PATH, then run \`workshop\`." ;;
esac
