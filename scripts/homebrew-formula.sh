#!/usr/bin/env bash
# Prints the Homebrew formula for a released version of Workshop, from its release's checksums.
# Usage: scripts/homebrew-formula.sh 0.4.0
set -euo pipefail

version=${1:?the version, such as 0.4.0}
repo=thomasschafer/workshop

sha() {
  local asset="workshop-v${version}-$1.tar.gz"
  local sum
  sum=$(gh release download "v${version}" -R "$repo" --pattern "${asset}.sha256" --output - | awk '{print $1}')
  if [[ ! "$sum" =~ ^[0-9a-f]{64}$ ]]; then
    echo "no checksum for ${asset}" >&2
    exit 1
  fi
  echo "$sum"
}

url() {
  echo "https://github.com/${repo}/releases/download/v${version}/workshop-v${version}-$1.tar.gz"
}

cat <<FORMULA
class Workshop < Formula
  desc "Solve Advent of Code puzzles by voice, from your phone"
  homepage "https://github.com/${repo}"
  version "${version}"
  license any_of: ["MIT", "Apache-2.0"]

  on_macos do
    on_intel do
      url "$(url x86_64-apple-darwin)"
      sha256 "$(sha x86_64-apple-darwin)"
    end

    on_arm do
      url "$(url aarch64-apple-darwin)"
      sha256 "$(sha aarch64-apple-darwin)"
    end
  end

  on_linux do
    on_intel do
      url "$(url x86_64-unknown-linux-musl)"
      sha256 "$(sha x86_64-unknown-linux-musl)"
    end

    on_arm do
      url "$(url aarch64-unknown-linux-musl)"
      sha256 "$(sha aarch64-unknown-linux-musl)"
    end
  end

  def install
    bin.install "workshop"
  end

  def caveats
    <<~EOS
      Start Workshop with \`workshop\`, or \`workshop serve --tailscale\` to open it on your phone.
      \`workshop doctor\` checks everything it needs, with fixes for anything missing.
    EOS
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/workshop --version")
  end
end
FORMULA
