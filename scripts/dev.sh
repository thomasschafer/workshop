#!/bin/sh
# Runs Workshop for development. The frontend and server rebuild when their sources change, and
# the server restarts only once a new build succeeds, so refreshing the page picks up changes.
#
# It runs separately from any Workshop you use day to day: on its own port, with its settings,
# token and history in .dev. The first run copies your config and Advent of Code cookie there,
# so it uses the same solutions folder. With --tailscale, it's served to your other devices on
# its own HTTPS port. macOS is kept awake unless WORKSHOP_KEEP_AWAKE is 0.
#
# Usage: scripts/dev.sh [--tailscale]
set -eu

port=7879
tailscale=false
case "${1:-}" in
  --tailscale) tailscale=true ;;
  "") ;;
  *)
    echo "Usage: $0 [--tailscale]" >&2
    exit 1
    ;;
esac

export WORKSHOP_HOME="$PWD/.dev"
if [ ! -d "$WORKSHOP_HOME/config" ]; then
  # Where Workshop keeps its config when WORKSHOP_HOME isn't set (see src/paths.rs).
  case "$(uname)" in
    Darwin) main_config="$HOME/Library/Application Support/workshop" ;;
    *) main_config="${XDG_CONFIG_HOME:-$HOME/.config}/workshop" ;;
  esac
  mkdir -p "$WORKSHOP_HOME/config"
  chmod 700 "$WORKSHOP_HOME"
  for file in config.toml aoc-session; do
    if [ -f "$main_config/$file" ]; then
      cp "$main_config/$file" "$WORKSHOP_HOME/config/"
      chmod 600 "$WORKSHOP_HOME/config/$file"
      echo "Copied $main_config/$file into $WORKSHOP_HOME/config"
    fi
  done
fi

# Stop everything this script started, whichever way it ends.
trap 'trap - EXIT INT TERM; kill 0 2>/dev/null' EXIT INT TERM

marker=target/debug/.workshop-built

cargo build
touch "$marker"

(cd frontend && npm run dev -- --logLevel warn) &

# Commands run in sh, not $SHELL: a login shell such as zsh can reset PATH from the system's
# profile, losing programs this script was started with, such as the model CLIs.
watchexec --quiet --postpone --shell sh \
  --watch src --watch prompts --watch languages --watch providers \
  --watch Cargo.toml --watch Cargo.lock --watch config.example.toml \
  -- "cargo build && touch $marker" &

serve="target/debug/workshop serve --bind 127.0.0.1:$port"
if [ "$tailscale" = true ]; then
  tailscale status >/dev/null 2>&1 || tailscale up
  serve="$serve --tailscale --https-port $port"
fi

if [ "${WORKSHOP_KEEP_AWAKE:-1}" != 0 ] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -w $$ &
fi

# In the background with `wait`, because a shell only runs its traps once a foreground command
# has finished.
watchexec --quiet --restart --shell sh --watch "$marker" -- "$serve" &
wait
