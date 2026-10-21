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

- [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex), logged in. Workshop uses your existing subscription.
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

This gives Workshop an HTTPS address on your tailnet, and prints a link and QR code to open on your phone. Keep the server awake while you're out; on a Mac, for example, with `caffeinate -i`. You can add Workshop to your phone's home screen to open it full screen like an app; on an iPhone, it asks for the link once more, as it doesn't share Safari's login.

The first time you open Workshop, a short setup walks you through choosing your language and model and logging in to Advent of Code. If you'd rather not paste your session cookie into the app, save it to the `aoc-session` file in Workshop's config directory (`workshop doctor` shows where), or set `AOC_SESSION`.

To try Workshop before logging in, or outside December, open the practice puzzle from the bottom of the puzzle list.

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
provider = "claude"    # or "codex"
model = "haiku"        # always the latest; for Codex, a family such as "luna"

[models.discuss]
provider = "claude"
models = ["sonnet", "opus", "fable"]    # for Codex, ["sol", "astra"]

[[snippets]]
name = "parse ints"
body = "map read . lines"
```

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

The model never gets to run commands or change files. With Claude Code, it's given no tools at all. Codex can't be run entirely without tools, so Workshop turns off every tool it can, runs Codex in its read-only sandbox, and stops it, making no edit, the moment it starts to use one.

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

Both `dev` and `serve` serve to your phone over Tailscale when it's installed, and keep macOS awake while they run.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
