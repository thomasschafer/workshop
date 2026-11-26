#!/usr/bin/env bash
# Runs editing cases through Helix itself, to check Workshop's Helix keybindings against it.
#
# Usage: HELIX_SRC=<a Helix checkout> scripts/helix-oracle/oracle.sh cases.json > results.json
#
# Each case is {"input": "text with #[|selection]#", "keys": "...", "lang": "haskell"?,
# "config": "<Helix [editor] TOML>"?}, in Helix's test markup. Each result, in the cases' order,
# is {"output", "text", "ranges": [[anchor, head], ...], "primary", "mode", "status"} or
# {"error"}; ranges are in characters (Unicode scalar values). Helix needs its grammars built
# (`hx --grammar fetch && hx --grammar build` in the checkout). The cases run in parallel, a few
# seconds each, with Helix's own test harness and test config (language servers off).
set -euo pipefail
: "${HELIX_SRC:?set HELIX_SRC to a Helix checkout}"
in=$(realpath "$1")
here=$(dirname "$(realpath "$0")")
shards=${ORACLE_SHARDS:-$(getconf _NPROCESSORS_ONLN)}
export HELIX_RUNTIME="${HELIX_RUNTIME:-$HELIX_SRC/runtime}"
cp "$here/oracle.rs" "$HELIX_SRC/helix-term/tests/oracle.rs"
cd "$HELIX_SRC"
# Without Helix's optional plugin system, so no user config or plugins can change what keys do.
features=(--release -p helix-term --no-default-features --features integration,git)
bin=$(cargo test -q "${features[@]}" --test oracle --no-run --message-format=json 2>/dev/null |
  jq -r 'select(.executable != null and .target.name == "oracle") | .executable')
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
n=$(jq length "$in")
for ((s = 0; s < shards; s++)); do
  jq "[to_entries[] | select(.key % $shards == $s) | .value]" "$in" >"$work/in-$s.json"
  ORACLE_IN="$work/in-$s.json" ORACLE_OUT="$work/out-$s.jsonl" "$bin" --nocapture --quiet >/dev/null 2>&1 &
done
wait
for ((s = 0; s < shards; s++)); do
  jq -c --argjson s "$s" --argjson k "$shards" '.index = .index * $k + $s' "$work/out-$s.jsonl"
done | jq -s "sort_by(.index) | if length != $n then error(\"got \\(length) results for $n cases\") else map(del(.index)) end"
