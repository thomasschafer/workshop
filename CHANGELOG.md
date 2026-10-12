# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0](https://github.com/thomasschafer/workshop/releases/tag/v0.1.0) - 2026-10-12

The first release.

### Added

- Solve Advent of Code puzzles by voice from your phone: hold the button, say the code roughly as you'd type it, and a model turns it into a precise edit at the cursor. It won't write logic for you, and asks when it isn't sure; you can reply to its questions.
- Edit models through Claude Code or Codex, using your existing subscription, with the model kept away from running commands.
- Instant voice commands that don't need the model, such as "undo", "run the sample" and "go to line 12".
- Haskell support, with error underlines and types from haskell-language-server.
- Puzzle and input fetching with caching, sample checks per part, running and submitting, and star tracking.
- Discuss mode, a coach that won't give the answer away unless asked, plus notes, snippets and committing your solutions repo.
- Saving as you go, so nothing is lost when you put the phone down, with conflict detection for edits made elsewhere.
- `workshop serve --tailscale` to reach Workshop from your phone over HTTPS, and `workshop doctor` to check your setup.
