# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.3.0](https://github.com/thomasschafer/workshop/compare/v0.2.0...v0.3.0) - 2026-10-14

### Other

- Prepare version 0.3.0
- Mention starting part 2 in Help
- Offer to start part 2 after the first star, and optionally commit and push after each star
- Run the end-to-end tests in WebKit too, as a stand-in for iPhones
- Say when the server can't be reached, and hold edits until it can; one undo step per voice edit
- On a wide screen, show the puzzle in a column beside the code
- Choose how to talk on each device, including the keyboard's dictation, and call the server the server
- Act on real usage: fewer pieces to the model, a cue for when listening starts, clearer imports and "this"
- Add a page comparing speech recognition, to decide what Workshop should use
- Make cards opaque, put the Run panel above everything, and wait for an editor still loading
- Stop the listening card flickering as words arrive, and make cancelling explicit
- Re-record the demo with utterance cards
- Show each utterance as a card stacked above the controls
- Let the edit model see the speech recogniser's own pieces when joining them took guesswork
- Format discussion replies as markdown

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
