# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.8.2](https://github.com/thomasschafer/workshop/compare/v0.8.1...v0.8.2) - 2026-11-25

### Other

- Draw shift as Gboard does in each state, and leave the space bar blank
- Style Workshop's keyboard as Gboard's, with its chevron to lower it
- Keep puzzle notes out of the solutions repo
- Offer to reload once a new release is ready, and reload by itself when it's safe
- Check the zen tabs can still be tapped once they've faded
- Let the tabs be tapped or clicked in zen mode
- Make keyboard shortcuts discoverable, add tab shortcuts, and let the puzzle column become a tab
- Use subtle grey download icon instead of green dots for cached puzzles and years
- Steady tests that failed on slow CI runners, and keep bench results whole
- Fix GHC WASM LSP -dynamic flag, default on-device to Automatic, and add resumable day-by-day offline year downloads
- Show the coach the notes, keep its replies through lost connections, and offer a retry
- Keep on-device bundle releases off Latest and avoid reload race in e2e
- Fix offline PWA cold start and AoC access on stalled or disconnected links
- Keep offline editing quiet and fall back cleanly on slow links
- Run the Antigravity author test only where Antigravity runs
- Close the page that offers no follow-ups once its route is done
- Never offer a card the grader marked again before the deck catches up
- Give the attempt marks were recorded as with them
- Keep a review's comment added while the last was still saving
- Run the codebase review and tutor server tests only where their stand-in model can
- Know a save landed when the page went before hearing so
- Keep a project's state as it's edited, and steady a review's comments
- Match a review's marks to its defects by id, and plan beside the code
- Keep a project's files from standing in for Python's or Workshop's own
- Name a project's failing test in the mistake log, and list codebases in pack tracks
- Document work in a codebase for pack writers and the author
- Test work in a codebase on a phone, in Chromium and WebKit
- Test the app's helpers for work in a codebase
- Work in a codebase and review changes in the app
- Work in a codebase's project, and review changes, on the server
- Read and check codebase items: fixes, reviews and refactors
- Point on-device Haskell bundle at 10-package GHC 9.14.1 release
- Exclude profiling shared libraries from GHC WASM rootfs to halve bundle size
- Add lookupSymbolPtr to dyld.mjs for GHC 9.14.1 bytecode linking
- Disambiguate String input for Parsec under OverloadedStrings in bundle smoke test
- Fix pkgroot-relative paths in merged extra package .conf files
- Enable shared: True under package * so cabal builds dyn libs for deps
- Follow symlinks when packing GHC WASM rootfs and log smoke-test stderr
- Build extra Haskell WASM packages via dummy cabal project
- Pass --store-dir before cabal install subcommand
- Fix GHC 9.14 Playground.hs API calls in bundle builder
- Fix upstream bsdtar.wasm URL
- Build self-contained 10-package GHC 9.14 WASM bundle with CI smoke test
- Add on-device GHC 9.14 WASM language server and sticky backend switching
- Add on-device GHC 9.14 WASM runner, bundle hosting, and offline Coding execution
- Build the frontend before the fast checks, as the server's tests serve it
- Stop talking by holding Ctrl
- Document what pack check now asks of problems in API mode and in parts
- Keep the app's view of a problem in parts right across reviews, devices and changed parts
- Keep parts and results in the server's hands, and check more of a problem's own programs
- Document coding problems in parts and in API mode, for packs and the author
- Say a part has passed where the next one starts, rather than in a notice
- Show a problem's parts on the phone, and calls in API mode
- Let coding problems come in parts, and call a class or functions in API mode
- Keep a card's controls working once its follow-ups end, and mark what was last said
- Change a card's follow-ups one request at a time
- Send a card's follow-ups so a lost reply can't misfile them
- Offer cards being followed up first, whatever today's limits
- Make a card's follow-ups safe to send again, and end them whatever the clocks say
- Let a card answered in your own words go deeper, with the tutor's questions
- Don't miss the server being lost while a screen first shows
- Follow a card up with the tutor's questions, and mark the whole exchange
- Share how a pack's add-on is added to a coach's instructions
- Let a card say how many follow-up questions it offers
- Remove a draft the author made into an item, even if the writer couldn't delete it
- Don't suggest a provider in doctor that can't run on this system
- Tell Antigravity's refused tools from ones that ran and failed
- Never let a call's process hold it up, or outlive its directory's cleanup
- Keep Antigravity from reading rules above its call's directory
- Refuse to run Antigravity on Windows
- Stop Antigravity if a tool runs, and wait for a call to end before tidying up
- Refuse call files that would clash with each other
- Say in doctor when the reviewer set in the config can't run
- Add Antigravity as a built-in provider
- Read Antigravity's JSON output
- Let a provider write files into a directory of each call's own
- Let Helix's pickers scroll by touch, and steady flaky browser tests
- Make completions and pickers easy to tap on a phone
- Make the talk button as tall as the buttons beside it
- Log what Advent of Code answers each submission with
- Say how to get the session cookie on an Android phone
- Ask to log in again when Advent of Code no longer accepts the session cookie
- Read the puzzle page when Advent of Code sends it back instead of a verdict
- Merge branch 'offline-first'
- Harden offline sync, conflict handling, and reconnect handover
- Keep a long question in view while typing at its end
- Let questions to the coach run over several lines
- Add offline Coding track, event-sourced session writer, and unified sync
- Add Advent of Code offline caching, versioned metadata, and on-device diagnostics
- Make app shell, home, goals, and mistakes resilient offline
- Compare typing on Workshop's keyboard with the phone's
- Keep failure screenshots and the test servers' logs when a browser test fails on CI
- Time each press on the page in the browser test of hearing with Whisper
- Wait for the round's last beat before changing it, in the timed round's browser test
- Wait for going back to finish before an overlay opened meanwhile takes its entry
- Show why the language server can't start, however soon it says so
- Wait for the page's frames to see the code is still, in the browser test of gliding
- Keep everything the sync chip says when a reply is lost, in the browser test
- Check a coding item's expected outputs fit in what's kept
- Say when a program's output was cut off, rather than comparing it
- Ask shims outside the sandbox which interpreter they start
- Format a manifest test
- Document tracks kept out of Continue, and a pack's default track
- Practise a track kept to itself in the app, and its problems
- Keep a track to itself, and offer the problems in a pack's track
- Read a pack's default track, and tracks kept out of Continue
- Test reading and solving in Haskell in the browser
- Document Haskell items, and check them in CI on Linux
- Solve coding problems in Haskell, with its language server
- Check Haskell in packs' coding problems and code to read
- Say why the language server refused, rather than "[object Object]"
- Say which reviewer the author uses and why, on the Packs page and in doctor
- Let the author's reviewer use the writer's own provider
- Answer a design round's questions from the prompt's brief, as a session does
- Have the learner ask the coach in a design session, which answers from the brief
- Mark what was asked about a design, against the brief it was answered from
- Add a built-in kind of mistake for a requirement missed in a design
- Give the sample pack's design prompts briefs
- Read a design prompt's brief, from a section of its own
- Leave out the line under Got it and Too easy after a right answer
- Move the page's clock on to see a language server isn't tried again, in the editor's browser test
- Wait for the app to say it's saved before reading the server, in the learning browser tests
- Wait for what's waiting to be sent when syncing, if a sync is already on its way
- Keep what's done offline from the server for certain, in the browser tests
- Save each stage of a design session moved through while a save was on its way
- Wait for the latest save when flushing, however many flushes wait together
- Bump toml ([#31](https://github.com/thomasschafer/workshop/pull/31))
- Accept how Windows words a language server's exit, in the browser test
- Test retiring and Got it on a phone, offline and on the Coding track, in the browser
- Explain retiring code to read and probability questions found too easy
- Ask the author for harder variants of code to read and probability questions found too easy
- Offer retiring code to read or a probability question once it's answered right
- Keep retiring and bringing back items in the app's outbox, and leave retired items out offline
- Take retirements of code to read and probability questions in a sync, and deal them in the deck
- Hold the page's clock still while the browser tests turn between tabs
- Double-tap shift in the browser tests as quickly as a thumb, however slow the machine
- Don't take code read before a save of its own landed for a change made elsewhere
- Say where the Coding track's programs come from, and that it can install them
- Check the Coding track's languages in doctor
- Give the Coding track each language's programs from mise, and offer to install them
- Stop reconnecting to a language server that can't start, and say why under the code
- Tell the editor why its language server can't start, rather than closing the connection
- Bring a retired problem back when it's done again and found harder, and offer solving it from a twist
- Keep text readable on the accent: the current step once it's done, disabled buttons and themes
- Review a coding problem with a twist on it, posed by the tutor and marked by the grader
- Ask the author for harder problems in skills whose problems were found too easy
- Let items say how hard they are, from 1 to 5, with difficulty
- List retired problems on the Coding track, each with a button to bring it back
- Retire a coding problem rated easy, so it's never offered again, until it's brought back
- Keep a language server's failed formats and own errors off the code
- Keep a sample that isn't a code block when the puzzle is opened again
- Let the sample pack be used alongside your own, with sample_pack under [learning]
- Give coding problems the keyboard button and zen mode Advent of Code has
- Try the author's lock again briefly, as a process being started can hold it for a moment
- Mark with the grader's own model in its test with no model CLI installed, as in CI
- Explain reading items in each language, and what each check means in it
- Add code to read in Python and Rust to the sample pack
- Highlight code blocks in packs' and coaches' Markdown for the language they're marked with
- Check reading items in Python and Rust by what each check means there
- Release only the binary, and tag only it, so the workspace's crates don't trip release-plz
- Offer the full keyboard for answers that can be fractions, percentages or negative
- Leave the week's minutes to the week's bar, not every reason to continue
- Wait for the practice page's opening sync before losing the next one's reply, in the browser test
- Run the author from the server on a schedule, set with every and after under [author], and show the next run under Packs
- Make the sample pack's mental maths harder: bigger numbers, carrying, and two-digit products
- Make the sample pack's Estimation track ten real estimates, with awkward numbers and a quick technique for each
- Let a mental maths template be an estimate, marked within a relative tolerance or a factor, and say how close with the question
- Tidy the spacing on the newer screens, mark empty lists alike, and keep unreached steps legible
- Give each track a small line icon, which a pack can choose for its own tracks
- Let the browser tests start more new items in a day than the default allows
- Refuse to use the real config and data from a development build unless WORKSHOP_HOME is set
- Give the grader a model of its own, under [models.grader] or in Settings, following the discussion's until chosen
- Offer at most `daily_new` new items a day, 10 by default, on the server and offline
- Let long items take turns with a while, rather than ranking a round above a design session for recent mistakes
- Log a marked attempt as forgotten only when the grader found nothing wrong in it
- Describe the sandbox items' programs run in, and what it doesn't stop
- Build and run items' programs in a sandbox, with no network and writing only to their own directory
- Describe the "I've got a while" toggle, explaining aloud, design sessions and timed rounds
- Take timed rounds in the app, with a clock, the examiner and the grader, carrying on after a break
- Show Timed rounds at home only with a while, or with a round under way
- Run timed rounds with the examiner, on the clock only while they're open, and mark them at the end
- Let a pack offer styles for the examiner, and add two design prompts to the sample pack
- Work through a design prompt as a session in the app, stage by stage, with the coach
- Share the list of steps between coding problems and other things done in steps
- Work through design prompts in stages, with a coach's follow-up questions at each
- Add a crate for long items done in a sitting: design sessions in stages, and timed rounds
- Explain cards, coding plans and solutions aloud, using dictation, for the grader to mark
- Mark work explained aloud for how clearly it's put, as well as whether it's right
- Add an "I've got a while" toggle to the home screen, for the current sitting
- Offer long items on Continue only when the learner has a while
- Expect the System design track on the home screen
- Describe the author, the grader, the mistake log and goals, and what the author's tools can reach
- Top up a pack from the app, approve what the author queued and answer its questions
- Run the author with `workshop author` or from the app, adding what both models agree on to the pack
- Add the author, which writes items for a pack and has another model review each blind
- Run a model CLI as an agent confined to one directory, for the author
- Import questions into a pack as drafts, from the app or with `workshop pack import`
- Mark design prompts, coding plans and cards in your own words in the app, and see to flagged cards
- Add a grader, which marks written work against a rubric and checks cards flagged as wrong
- Show progress towards each goal: its skills against the target, the trend and what's weakest
- Browse the mistake log in the app, and confirm or change each mistake's kind
- Log mistakes from wrong answers and failed submissions, and practise their skills sooner
- Keep a log of mistakes, each tagged with a kind of mistake a pack can add to
- Say a reference didn't build, rather than that it's wrong, as the toolchain may be why
- Describe coding problems, code to read and the Coding track in the docs
- Work through coding problems a step at a time on a phone, with the editor, runner and tutor
- Read code and say what it prints or what's wrong with it, offline too
- Name compiled programs as Windows expects
- Share the editor's settings, its language server and coaches' conversations beyond Advent of Code
- Add coding problems solved in steps, and C++ to read, checked by running them
- Count time spent on the steps of longer items towards the week
- Describe packs, practice and working offline in the docs
- Keep the app on the phone, to practise offline and sync answers later
- Practise review cards, mental maths and probability, a few minutes at a time
- Show the pack's tracks on the home screen, and sync attempts made in the app
- Keep a log of attempts, and schedule items from it with FSRS
- Check a pack's items with `workshop pack check`, and describe the format
- Add packs of things to learn, with a sample pack and each item's check
- Describe the home screen and the shared crates in the docs
- Add a local content check, to keep phrases of your own out of commits
- Open on a home screen, with Advent of Code as one track
- Make Advent of Code a track, with the puzzle it would continue with
- Add tracks, and choosing what to continue with across them
- Move sending Web Push notifications into a crate of their own
- Move the token that guards the server into a crate of its own
- Move the language server relay and Tailscale serving into crates
- Move building and running programs into a crate of their own
- Move toolchains and packages into a crate of their own
- Move the model CLIs into a crate of their own
- Make Workshop a Cargo workspace, starting with a crate of shared pieces
- Add agent instructions that keep the repo general
- Format the code before each run, and once Helix is left alone
- Import what's completed, however the language server adds the import
- Give each checkout its own port and home for the browser tests
- Lock a modifier on Workshop's keyboard by tapping it twice quickly
- Wait for a pause in typing before offering completions
- Name the card the swipe test waits for, which others can share the screen with
- Fix the zen mode tests where a browser won't go full screen, and tidy
- Slide between tabs when they're turned by a sweep or a shortcut
- Fix what Safari showed of the problem under the cursor and sweeping between tabs
- Keep the language server for an editor that comes back
- Move through completions with Helix's keys on any keyboard
- Complete as you type, and use the language server with the editor's own keys
- Add keyboard shortcuts for running, zen mode and turning between tabs
- Turn to other tabs in zen mode, with two fingers on a phone
- Say what's wrong where the cursor is, and show the whole of it when asked
- Ask the language server from Helix's own prompt and lists
- Press the nearest key on Workshop's keyboard, and learn where keys are touched
- Keep Escape for Helix in zen mode
- Float Helix's key help in the corner, only as big as it needs
- Glide the code when Helix's keys scroll it
- Let the code be pinched down to a tenth of its size
- Pinch the code to change its text size
- Type on Workshop's own keyboard with Helix's keybindings on a phone ([#29](https://github.com/thomasschafer/workshop/pull/29))
- Keep Helix's status line under sheets, and make it taller on phones
- Make Helix's keybindings work well on a phone ([#28](https://github.com/thomasschafer/workshop/pull/28))
- Cover the page with the keyboard in zen mode, sizing it to fit
- Run the code to the top of the screen in zen mode
- Add zen mode, showing just the code and the keyboard
- Keep the Discuss draft when switching tabs
- Wait for the day's heading in the Helix test, which a switching puzzle can show twice
- Test reading keys from the browser and keymaps from config
- Add Helix keybindings to the code editor, on per device or from the config
- Port Helix's editing model and keymap, checked against Helix's own tests
- Let unwrapped code scroll well past the end of its longest line
- Bump release-plz/action ([#25](https://github.com/thomasschafer/workshop/pull/25))
- Bump toml ([#26](https://github.com/thomasschafer/workshop/pull/26))
- Bump rustls from 0.23.45 to 0.23.46 ([#24](https://github.com/thomasschafer/workshop/pull/24))
- Bump tokio from 1.53.3 to 1.54.1 in the cargo-minor-and-patch group ([#20](https://github.com/thomasschafer/workshop/pull/20))
- Bump release-plz/action ([#23](https://github.com/thomasschafer/workshop/pull/23))
- Read quoted strings and BigInts as answers, and warn about decimal ones
- Find part 2's sample when the puzzle wraps its answer in brackets, and never run part 1's in its place
- Keep the coach to the question asked, without raising other problems
- End saved solutions and notes with a newline
- Name puzzles in commit messages by year and day only
- Compare committed paths by component in the commit test
- Only commit tracked changes and Workshop's own files
- Keep the puzzle scrolled where it was after looking at another tab
- Bump libc from 0.2.190 to 0.2.191 in the cargo-minor-and-patch group ([#17](https://github.com/thomasschafer/workshop/pull/17))
- Bump the github-actions-minor-and-patch group with 2 updates ([#16](https://github.com/thomasschafer/workshop/pull/16))
- Bump the npm-minor-and-patch group in /frontend with 3 updates ([#18](https://github.com/thomasschafer/workshop/pull/18))

## [0.8.1](https://github.com/thomasschafer/workshop/compare/v0.8.0...v0.8.1) - 2026-10-24

### Other

- Never take over another app's Tailscale address
- Run mise run dev alongside any Workshop already in use
- Let serve --tailscale use another HTTPS port, and find the right served address
- Say how else to reach Workshop from a phone, rather than pointing at the README
- Trim the README to what a first read needs

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
