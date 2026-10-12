# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0](https://github.com/thomasschafer/workshop/releases/tag/v0.1.0) - 2026-10-12

### Other

- Read an empty find as "at the cursor", and support local models through Ollama
- Retry edits that don't fit the file, and show the model the cursor's line
- Keep listening through pauses, let users reply to the model's questions, and more
- Show dictation examples in the contributing guide's Python profile
- Show help as a modal, with dictation examples from the language profile
- Add a Codex preset, and explain runs for puzzles without an example
- Treat a dropped language server connection as a normal end, not a warning
- Add help, show the puzzle input, and handle older puzzles and the final day
- Treat symbols spoken as words, like "open (", as the symbols they name
- Use Android's latest speech guess instead of joining its restatements
- Fix data-loss, hang and leak issues found in review
- Add eval cases for chatty phrasing and edits by line number
- Document the edit evals in the contributing guide
- Keep the phone screen on while Workshop is open, with a setting to turn it off
- Give each part its own sample, guess samples from how puzzles introduce them, and fix dev rebuilds
- Add an edit eval set, and Haskell hints for wrapping and numbered names
- Retry failed saves, and reconnect to the language server after it drops
- Add a dry-run mode to the release workflow
- Add a hot-reloading dev mode, and stop promptly on Ctrl-C
- Merge Android Chrome's cumulative speech results instead of repeating them
- Start on the puzzle picker, and open it full screen from the header
- Log utterances, model replies and phone-side errors to a local file
- Use a SameSite=Lax cookie so token links opened from a QR code work
- Show tailscale serve's output so prompts to enable Serve aren't hidden
- Add serve --tailscale with a QR code, and a mise serve task
- Add README and contributing guide, and identify doctor's network check
- Add phone-first frontend with voice editing, problem view, runs and discussion
- Add backend, providers, Haskell profile and repo automation
- Add readme
