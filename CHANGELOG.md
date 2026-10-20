# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.0](https://github.com/thomasschafer/workshop/compare/v0.7.0...v0.8.0) - 2026-10-20

### Other

- Release 0.8.0, as the config can now turn on committing after each star
- Split the app's concerns into hooks, and share one error message helper
- Split the server into a module per area
- Run the tests, the app's and the install script on macOS in CI
- Show only titles in the settings list, and a line when something needs doing
- Leave the formula's version to Homebrew, which reads it from the URLs
- Let the config turn on committing after each star
- Mention committing after each star, and every built-in language in the config

## [0.7.0](https://github.com/thomasschafer/workshop/compare/v0.6.0...v0.7.0) - 2026-10-20

### Other

- Release 0.7.0, as finding examples with the model is new
- Keep the PATH dev.sh is started with for the commands it watches
- Let dev.sh leave keeping the machine awake to something else
- Use whisper.cpp's current Homebrew formula name
- Bump release-plz/action ([#13](https://github.com/thomasschafer/workshop/pull/13))
- Bump tokio from 1.53.2 to 1.53.3 in the cargo-minor-and-patch group ([#12](https://github.com/thomasschafer/workshop/pull/12))
- Align Dependabot config with baseline ([#11](https://github.com/thomasschafer/workshop/pull/11))
- Mark an example written inline as the sample, and only the answer that belongs to it
- Bump vitest in /frontend in the npm-minor-and-patch group ([#10](https://github.com/thomasschafer/workshop/pull/10))
- Bump base64 from 0.22.1 to 0.23.1 ([#9](https://github.com/thomasschafer/workshop/pull/9))
- Align Dependabot config with baseline ([#8](https://github.com/thomasschafer/workshop/pull/8))
- Find a puzzle's example with the edit model when the page doesn't make it clear
- Keep haskell-language-server's notes plugin from covering the code with its internal errors
- Merge Dependabot's updates once CI passes, check the real toolchains weekly, and add mise run check-fast
- Hear long, repetitive dictation, such as a sum of every number up to 20
- Keep the code scrolled where it was when an edit lands at the end of a long line

## [0.6.0](https://github.com/thomasschafer/workshop/compare/v0.5.0...v0.6.0) - 2026-10-16

### Other

- Keep the request priority test steady on slow machines
- Prepare version 0.6.0
- Install packages for Rust, Go and TypeScript
- Get to an opened puzzle sooner, and catch up when a part was solved elsewhere
- Fail the release when the Homebrew tap token is missing or can't push
- Give the release workflow the Homebrew tap token when release-plz calls it

## [0.5.0](https://github.com/thomasschafer/workshop/compare/v0.4.0...v0.5.0) - 2026-10-15

### Other

- Prepare version 0.5.0
- Solve in Rust
- Solve in Go
- Solve in TypeScript, run with Deno
- Install with Homebrew or a script, and hear when there's a newer release
- Run and check the right sample when working through a solved puzzle again
- Check runs on the real input against answers already accepted, such as part 1's while solving part 2
- Add the imports an edit needs, including for the user's own helpers
- Format the help text
- Notify devices when puzzles unlock, for those that ask
- Show a private leaderboard, when one is chosen
- Get ready for December: unlock times, today's puzzle, a countdown and your times
- Only hear speech: tell it apart from other sound before Whisper hears it
- Give runs longer in the end-to-end tests, as a program's first start can be slow on Windows
- Fail CI when the Windows tests fail, now that they pass
- Join search paths and build paths as Windows expects, and run Python packages there
- Quote paths in the end-to-end tests' config so Windows paths are read correctly
- Check files out with Unix line endings on Windows too, as tests and built-in templates expect
- Run the tests on Windows in CI
- Talk by holding Ctrl on a computer

## [0.4.0](https://github.com/thomasschafer/workshop/compare/v0.3.0...v0.4.0) - 2026-10-15

### Other

- Prepare version 0.4.0
- Always say the microphone is allowed after a press that asked for it, as recording only began once the button was let go
- Pick up code changed at the server while the app is open, without false conflicts
- Make the controls smaller on a phone held sideways, leaving room for the code
- Keep what's typed in full colour, and stop iPhones zooming into text fields
- Mention adding Workshop to a phone's home screen in the README
- Wrap long strings in a puzzle's sentences rather than widening the page
- Say when a puzzle has no solution yet, rather than that the compiler is missing
- Name the code editor for screen readers, give the page a heading, and make line numbers easier to read
- Bring the help up to date: the Run panel, Settings' pages, ways of hearing speech, and adding Workshop to a home screen
- Find Tailscale inside its macOS app, and say how to give it permission on Linux
- Say what to do when the model CLI is logged out, at its usage limit or busy
- Offer to log in again when Advent of Code stops accepting the cookie
- Show paths in run output relative to the solutions repo, and say when nothing was printed
- Say what to do when Workshop's port is already in use
- Show where solutions are kept, and only make the repo when it's needed
- Make Workshop installable as an app, and let the token be pasted
- Settings as a list of pages, and say "Transcribing…" while Whisper hears it
- Check Whisper in workshop doctor
- Hear dictation with whisper-server, which keeps the model loaded
- Get recording ready before the first press, and polish what a press shows
- Fit the dictation choices on a phone screen
- Say the microphone is allowed after the first press asks for it, rather than to hold the button
- Let a recording be cancelled while it's being heard or waiting for the server
- Keep dictation in the order it was said, and keep it through hiccups
- Record dictation as raw sound, and keep cards still when one above leaves
- Dictate with Whisper on the server, and show when to start speaking
- Start the browser before the server in the demo and package check scripts, so a browser that won't launch doesn't leave the server running
- Shorten the README's opening and re-record the demo
- Install a language's programs with mise when they're missing
- Add workshop run and workshop env, for working on solutions from a terminal
- Make the speech benchmark resumable, its button bigger, and the phrase to read stay in view
- Hide the controls on the Problem tab

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
