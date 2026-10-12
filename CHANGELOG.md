# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0](https://github.com/thomasschafer/workshop/compare/v0.1.0...v0.2.0) - 2026-10-12

### Other

- Re-record the demo
- Prepare version 0.2.0
- Teach the edit model about the helpers module and imports from anywhere, with evals
- Stream discussion replies as they're written, and tell the coach about helpers and packages
- Add a helpers module that every solution can import
- Add a practice puzzle that needs no Advent of Code login
- Document the new package profile fields
- Round out packages: look up unknown modules, follow and cancel installs, and add or remove packages
- Install packages for solutions, with a standard set for Haskell and a prompt when a module is missing
- Re-record the demo with the new editing indicator
- Show edits in progress on the talk button, with a timer, and a glow when they land
- Wait for pending edits before running, add a line wrapping setting, and add the demo GIF
- Make settings full screen on phones, close overlays on back, and keep tests off Advent of Code
- Split the app component into views and hooks, and test discussion end to end
- Add terminal colour themes
- Add end-to-end tests, and save the chosen sample before a run
- Add first-run setup in the app
- Add a Python language profile, and run evals for each language
- Switch between Claude Code and Codex, and their models, from the app
- Explain allowing the downloaded binary on macOS

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
