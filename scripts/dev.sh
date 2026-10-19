#!/bin/sh
# Runs Workshop for development. The frontend and server rebuild when their sources change, and
# the server restarts only once a new build succeeds, so refreshing the page picks up changes.
# With Tailscale running, it's served to your other devices too, and macOS is kept awake unless
# WORKSHOP_KEEP_AWAKE is 0, such as when it runs in the background all the time.
set -eu

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

if command -v tailscale >/dev/null 2>&1; then
  tailscale status >/dev/null 2>&1 || tailscale up
  target/debug/workshop token --tailscale
fi

if [ "${WORKSHOP_KEEP_AWAKE:-1}" != 0 ] && command -v caffeinate >/dev/null 2>&1; then
  caffeinate -i -w $$ &
fi

# In the background with `wait`, because a shell only runs its traps once a foreground command
# has finished.
watchexec --quiet --restart --shell sh --watch "$marker" -- target/debug/workshop serve &
wait
