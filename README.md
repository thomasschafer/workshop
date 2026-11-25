# Workshop

Solve [Advent of Code](https://adventofcode.com) puzzles by voice, from your phone.

Workshop runs on a server you control, such as your laptop, a desktop or a VPS, and you open it on your phone. Hold the button and say the code you want, roughly as you'd type it, and a model turns it into a precise edit at your cursor. It's built for working one-handed, away from a desk.

<p align="center">
  <img src="docs/demo.gif" width="300" alt="Workshop on a phone: dictating an import and two lines of Python, then running them on the sample and the real input">
</p>

- Edits relative to the cursor, like "before that" or "wrap that in parens". Misheard words like "fold are" for `foldr` are fixed from context.
- Run on the sample and your input, then submit, with inline errors and types from your language server.
- A discuss mode: a coach that sees the puzzle and your code, and won't give the answer away unless you ask.
- Haskell, Python, TypeScript, Go and Rust built in, and other languages can be added in your config.
- Instant commands like "undo" and "run the sample", plus notes, snippets, and committing your solutions to git.

Workshop is voice editing, not code generation: you dictate the code itself, so "write a function to sort a list" won't do anything. If Workshop isn't sure what you meant, it makes no edit and tells you why.

Workshop is unofficial and isn't affiliated with Advent of Code.

## Requirements

- [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex) or the [Antigravity](https://antigravity.google) CLI, logged in. Workshop uses your existing subscription.
- Your language's toolchain, or [mise](https://mise.jdx.dev) to install it for you.
- Your Advent of Code session cookie.
- A way to reach the server from your phone over HTTPS, which browsers require for the microphone. [Tailscale](https://tailscale.com) works well.
- Optionally, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`brew install whisper.cpp` on macOS), which hears code more accurately than your phone's speech recognition.

`workshop doctor` checks all of these and tells you how to fix anything missing.

## Getting started

Install Workshop with [Homebrew](https://brew.sh), on macOS or Linux:

```sh
brew install thomasschafer/tap/workshop
```

Or with the install script, which puts it in `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/thomasschafer/workshop/main/install.sh | sh
```

Or download a binary from the [releases page](https://github.com/thomasschafer/workshop/releases). On macOS, a binary downloaded in a browser is blocked until you allow it in System Settings, Privacy & Security, or with `xattr -d com.apple.quarantine workshop`.

Then:

```sh
workshop doctor   # check your setup, with fixes for anything missing
workshop          # start the server and print the link to open
```

To use it from your phone over Tailscale, start it with:

```sh
workshop serve --tailscale
```

This gives Workshop an HTTPS address on your tailnet, and prints a link and QR code to open on your phone. If Tailscale already serves Workshop, it reuses that address; otherwise it uses your machine's bare address (port 443). It never takes over a port another app is served on: if 443 is in use, pick another with `--https-port`, such as `workshop serve --tailscale --https-port 8443`. `workshop token --tailscale` takes the same options, and prints the link without starting the server. Keep the server awake while you're out; on a Mac, for example, with `caffeinate -i`. You can add Workshop to your phone's home screen to open it full screen like an app; on an iPhone, it asks for the link once more, as it doesn't share Safari's login.

The first time you open Workshop, a short setup walks you through choosing your language and model and logging in to Advent of Code. If you'd rather not paste your session cookie into the app, save it to the `aoc-session` file in Workshop's config directory (`workshop doctor` shows where), or set `AOC_SESSION`.

Workshop opens on a home screen, whose Continue button goes straight to the most sensible next step, such as the puzzle you were last working on or the cards due for review. Below it are the tracks: Advent of Code, Coding, and tracks of short items from a pack. A pack's own track can keep to itself, so Continue never offers it and it has limits of its own, for something you only practise when you open it. Everything takes a few minutes at a time unless you turn on "I've got a while", which lets Continue offer long items too: design sessions and timed rounds, taking turns, though one you've left unfinished always comes first. It stays on while you're using the app, and turns itself off once you've been away for half an hour.

## Packs and practice

Besides Advent of Code, Workshop practises short items from a pack: review cards you mark yourself, mental maths with fresh numbers each time, and probability questions with exact answers. A pack is a directory of Markdown files, usually a git repo of your own; [docs/packs.md](docs/packs.md) describes the format. Until you configure one, Workshop uses its small sample pack.

Practice comes in steps of a few minutes, and each answer is saved as you give it, so you can stop at any moment. Items come back when you're due to forget them, scheduled with [FSRS](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm). Continue puts due reviews first, up to a daily limit, and the home screen counts your practice towards a weekly target rather than a streak.

Short items work offline: once a phone has opened Workshop, it keeps what it needs to practise, and syncs your answers when it can reach the server again.

## Coding

The Coding track has problems to solve in Python, Rust or Haskell, fully on a phone, and code to read in Python, Rust, Haskell or C++. A problem is a chain of short steps: understand it, by working out what an example prints; plan, typed or dictated; code, in Workshop's editor, with Helix's keybindings and Workshop's own keyboard if you like, and the language server; then submit it, to hidden tests and a comparison with a slow but sure solution on random inputs, which shows you a small input it fails on if it's wrong. Last, compare it with how it's meant to be solved, and say how it went. Each step is saved as you go, your code included, so you can stop at any moment and Continue picks up where you were, on any device. If the problem's language, or its language server, isn't installed, a problem in it offers to install it with mise, for the Coding track only. It also has work in a codebase someone else wrote, a small project of a few files to switch between: fixing a bug from its symptom, reviewing a change by commenting on its lines, or refactoring code so tests can be written for it, then extending it.

A tutor gives hints that don't give the problem away, through your discussion model. Problems come back for review as a short twist on them, posed by the tutor and marked by the grader, or solved again if they went badly; a problem you rate easy is retired, and the author writes harder ones in its skills. Code to read asks what it prints, what's wrong with it or what it costs, and works offline; running code and the tutor need the server. Answered right, code to read or a probability question can be retired as too easy, so it isn't learnt by heart, and the author writes harder variants of it.

`workshop pack check` checks every item in a pack: that it can be read, that a probability question's simulation agrees with its answer, that a mental maths template makes sensible questions, that a coding problem's solutions pass its tests and agree with its brute force on random inputs, and that code to read does what its answer says.

To try Workshop before logging in, or outside December, open the practice puzzle from the bottom of the puzzle list.

## Design sessions and timed rounds

A design prompt is worked through as a session in stages, from the requirements to the trade-offs. You find out the requirements and the scale by asking the coach, which answers from a brief you see only at the end, then it asks you follow-up questions about your design, and the grader marks the whole session, and what you asked, at the end. Each stage is saved as you write, so you can stop at any of them.

A timed round puts a coding problem, a probability question or a design prompt against a visible clock, with an examiner who answers your questions and asks follow-ups that extend or change the problem, as a live session would. When time's up, the grader marks your working and what was said. The clock only runs while the round is open: close the app and come back within half an hour, and it carries on where it was; leave it longer, and the round ends there and is marked on what you did, without counting as an attempt. A pack can offer styles for the examiner, such as how many hints it gives and how hard it probes, to choose from as a round starts.

Cards, coding plans and solutions, design notes and what you say to the coaches can all be dictated, and some can be explained aloud: the grader then marks how clearly you put it, as well as whether it's right.

A card answered in your own words can go deeper: the tutor asks a few follow-up questions about what you said, such as why it's so or what happens in an edge case, and the grader marks the whole exchange for how deeply you understand it. Each answer is saved as you give it, so you can close the app part-way and carry on.

## Mistakes, goals and the grader

Wrong answers, failed submissions and what the grader finds go into a mistake log, each tagged with a kind of mistake, such as an off-by-one or a misreading, which you can confirm or change; a pack can add kinds of its own. Practice, and Continue, lean towards the skills your recent mistakes are in. Each goal a pack defines has a page showing its skills against the goal's target, how it's changed over the last few weeks, how long is left, and what's weakest.

The grader, through your discussion provider's first model unless you give it one of its own under Settings, Models, or `[models.grader]` in your config, marks written and spoken work against a rubric: design sessions, timed rounds, a coding problem's plan and how its solution works, and a card answered in your own words, with any follow-up questions on it. Its score counts towards scheduling and mastery, and what it finds goes in the mistake log. It also checks cards you've flagged with "This is wrong", unflagging those that are right, and proposing a fix for those that aren't, which changes your pack once you approve it.

The author writes new items for a pack of your own, for what you're weakest in and the mistakes you make most: one model writes them, a model from another provider solves each blind and reviews it, and each must pass its check. Run it with `workshop author`, or Top up under Packs in the app, or have the server run it every so often, with `every` under `[author]`; [docs/author.md](docs/author.md) describes it. Questions you've found elsewhere can be added to a pack as drafts, under Packs or with `workshop pack import`, for the author to make into items.

## Configuration

Most things can be changed in the app under Settings, including the model, colour theme, and committing (and pushing) after each star. Workshop also writes a commented config file on first run; `workshop doctor` shows where it is. The defaults:

```toml
[server]
bind = "127.0.0.1:7878"

[solutions]
dir = "~/aoc"          # a git repo, created on first use
language = "haskell"   # or "python", "typescript", "go" or "rust"
commit_after_star = false

[models.edit]
provider = "claude"    # or "codex" or "antigravity"
model = "haiku"        # always the latest; for Codex, a family such as "luna"

[models.discuss]
provider = "claude"
models = ["sonnet", "opus", "fable"]    # for Codex, ["sol", "astra"]

# [models.grader]      # the discussion provider's first model unless set
# provider = "codex"
# model = "sol"        # the provider's first discussion model if not given

[learning]
packs = []              # pack directories; the sample pack until you list one
sample_pack = false     # also use the sample pack alongside your own
daily_reviews = 40      # the most reviews Continue offers in a day
daily_new = 10          # the most new items Continue offers in a day
weekly_minutes = 90     # the week's target
desired_retention = 0.9 # how likely you should be to remember an item when it comes back

[[snippets]]
name = "parse ints"
body = "map read . lines"
```

With a keyboard, the code editor can use [Helix](https://helix-editor.com)'s modal keybindings instead of its own: turn them on for a device under Settings, Display, or for every device with `keybindings = "helix"` under `[editor]`. Your own Helix keymaps and the Helix options Workshop follows go under `[editor.helix]`, in the same format as Helix's config; the commented config file lists them. Commands that work across files, splits, shell commands and anything needing tree-sitter aren't available, and say so if you press them. On a phone or tablet they come with Workshop's own keyboard in place of the phone's: a laptop's keys, with Escape, Ctrl, Alt and a number row, and the letters where Gboard has them. A touch presses the nearest key, and the keyboard learns where you touch each one as you type; Settings, Display has a minute's typing that measures it outright.

The code is formatted, by the language server or for Python by Ruff, before each run and, with Helix's keybindings, once it's been left in normal mode for a few seconds after a change. Only what formatting changes is touched, so the cursor stays where it was, and undoing a format keeps it undone. Shift-Alt-F, or `:format` and `=` in Helix, formats whenever you like; `format_automatically = false` under `[editor]` turns the rest off.

An error the language server reports itself, rather than in the code, shows as "server error" above the code; tap it to read the whole message with the code's problems. The language server can be restarted from there, or with `:lsp-restart` in Helix.

With a keyboard there are shortcuts for running, zen mode, going straight to a tab or turning between them, and moving the puzzle, whichever keybindings the code has. The keyboard button at the top lists them, as do the help and Cmd-Shift-/ on a Mac or Ctrl-Shift-/ elsewhere, and hovering over a button shows its shortcut. On a wide screen the puzzle sits in a column beside the code; the button at the start of the tabs, or Alt-\, makes it a tab of its own, for more room for the code, and puts it back. On a touch screen, two fingers swept sideways turn to the next tab or back.

To compare models on the same set of example utterances, use `workshop eval --model codex:luna`, for example. Workshop checks once a day for a newer release; set `check_for_updates = false` under `[server]` to turn this off.

## Your solutions

Your program reads the puzzle input on stdin and prints the part 1 answer on the first line and the part 2 answer on the second.

Solutions are ordinary files in your solutions repo, so you can also edit and run them with your own editor. Workshop writes a README there with the details. In short:

```sh
workshop run 2024 1            # build and run a solution on your input, as the app does
workshop run 2024 1 --sample   # on the example chosen in the app, checking its answers
eval "$(workshop env)"         # set up a shell, and an editor started from it, as the app runs solutions
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding a language or a model CLI.

## Security

Workshop runs code and spends your model subscription, so it only listens on localhost by default and every request needs the token. Use `workshop serve --tailscale` rather than binding to other interfaces.

The model never gets to run commands or change files, except the author's writer, below. With Claude Code, it's given no tools at all. Codex can't be run entirely without tools, so Workshop turns off every tool it can, runs Codex in its read-only sandbox, and stops it, making no edit, the moment it starts to use one. Antigravity can't either, and its own permission settings don't stop its shell, so each call runs in a directory of its own with a hook there that refuses every tool before it runs, and Workshop stops it, using none of its reply, if a tool ever runs anyway. Your own global Antigravity config still applies, though, tools staying refused: its rules, in `~/.gemini/AGENTS.md`, its hooks and its MCP servers. Antigravity doesn't work with Workshop on Windows yet.

The author's writer is the only model with tools, and only in a copy of your pack: with Claude Code, just its file tools, in its restricted mode; with Codex, in its workspace-write sandbox with no network. [docs/author.md](docs/author.md) says what each guarantees, and what it doesn't.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Advent of Code

Workshop caches puzzles and inputs, spaces out its requests, and identifies itself with a User-Agent pointing at this repo, following Advent of Code's guidance for automated tools. Advent of Code asks that puzzle text and inputs aren't published, so Workshop keeps them outside your solutions repo.

## Development

With [mise](https://mise.jdx.dev) installed:

```sh
mise run dev     # rebuild and restart on every change; refresh the page to see it
mise run serve   # an optimised build, for when you're just using Workshop
mise run check   # everything CI runs; check-fast skips the browser tests
mise run build   # a release binary with the frontend embedded
```

`serve` serves to your phone over Tailscale when it's installed, and takes `--https-port` as `workshop serve` does. `dev` runs alongside any Workshop you already use: on port 7879, with its own settings and history in `.dev`, starting from a copy of your config and Advent of Code cookie. `mise run dev --tailscale` serves it to your phone too, on its own HTTPS port. Both keep macOS awake while they run.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.

The track icons in `frontend/src/tracks/icons.tsx` are from [Lucide](https://lucide.dev), under the ISC licence, whose notice is at the top of that file.

Most of `frontend/src/helix`, the Helix keybindings, is ported from [Helix](https://github.com/helix-editor/helix). The ported files are under the [Mozilla Public License 2.0](https://mozilla.org/MPL/2.0/), as Helix is, and each says so at its top.
