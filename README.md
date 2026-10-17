# Workshop

Solve [Advent of Code](https://adventofcode.com) puzzles by voice, from your phone.

Workshop runs on a server you control, such as your laptop, a desktop or a VPS, and you open it on your phone. Hold the button and say the code you want, roughly as you'd type it, and a model turns it into a precise edit at your cursor. It's built for working one-handed, away from a desk.

<p align="center">
  <img src="docs/demo.gif" width="300" alt="Workshop on a phone: dictating an import and two lines of Python, then running them on the sample and the real input">
</p>

- Edits relative to the cursor: tap to place it, then "before that", "wrap that in parens", and so on. Misheard words like "fold are" for `foldr` are fixed from context.
- Run on the sample and your input, then submit, all from the phone, with inline errors and types from your language server.
- A discuss mode: a coach that sees the puzzle and your code, and won't give the answer away unless you ask.
- Haskell, Python, TypeScript, Go and Rust built in, with a helpers module of your own. Import a package you haven't installed and Workshop offers to install it. Other languages can be added in your config.
- Instant commands like "undo" and "run the sample", notes, snippets, and committing your solutions, all saved as you go.

Workshop is voice editing, not code generation. "Write a function to sort a list" won't do anything. "Function solve from String to Int", then "solve equals lines", "before that map read dot" and "before that sum dot" gives you `solve = sum . map read . lines`. If Workshop isn't sure what you meant, it makes no edit and tells you why.

Workshop is unofficial and isn't affiliated with Advent of Code.

## Requirements

- A model CLI that you're logged in to, used through your existing subscription: [Claude Code](https://claude.com/claude-code) or [Codex](https://developers.openai.com/codex). Workshop sets itself up for whichever you have.
- [mise](https://mise.jdx.dev), which setup uses to install your language's toolchain for your solutions repo only. If you already have your language's toolchain (GHC and cabal, Python 3, Deno for TypeScript, Go, or Rust), and optionally its language server for error underlines and types, you don't need mise.
- Your Advent of Code session cookie.
- Optionally, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) on the server (`brew install whisper-cpp` on macOS), which hears code more accurately than phones' own speech recognition. Setup downloads its model.
- A way to reach the server from your phone over HTTPS, which browsers require for the microphone. [Tailscale](https://tailscale.com) works well.

## Getting started

Install Workshop with [Homebrew](https://brew.sh), on macOS or Linux:

```sh
brew install thomasschafer/tap/workshop
```

Or with the install script, which puts it in `~/.local/bin`:

```sh
curl -fsSL https://raw.githubusercontent.com/thomasschafer/workshop/main/install.sh | sh
```

Or download a binary from the [releases page](https://github.com/thomasschafer/workshop/releases) and put it somewhere on your PATH. On macOS, a binary downloaded in a browser is blocked until you allow it, either in System Settings, Privacy & Security, or with `xattr -d com.apple.quarantine workshop`.

Then:

```sh
workshop doctor   # check your setup, with fixes for anything missing
workshop          # start the server and print the link to open
```

Workshop checks once a day for a newer release, and says in Settings how to update when there is one. To stop it checking, set `check_for_updates = false` under `[server]` in its config.

To use it from your phone over Tailscale, start it with:

```sh
workshop serve --tailscale
```

This runs `tailscale serve` for you, which gives Workshop an HTTPS address on your tailnet, and prints a link and QR code to open on your phone. The token in the link is then remembered by your phone's browser. Keep the server awake while you're out; on a Mac, for example, with `caffeinate -i`.

Add Workshop to your phone's home screen from the browser's menu, and it opens full screen like an app. On an iPhone, the app asks for the link once more, as it doesn't share Safari's login; paste the link or its token.

The first time you open Workshop, a short setup walks you through choosing your language and model, logging in to Advent of Code with your session cookie, and opening Workshop on your phone. You can run it again from Settings. If you'd rather not paste the cookie into the app, save it to the `aoc-session` file in Workshop's config directory (`workshop doctor` shows where), or set `AOC_SESSION`.

To try Workshop before logging in, or outside December, open the practice puzzle from the bottom of the puzzle list. It's made up for Workshop and works like a real puzzle, including submitting answers, which it checks itself.

## Configuration

Workshop writes a commented config file on first run; `workshop doctor` shows where it is. The defaults:

```toml
[server]
bind = "127.0.0.1:7878"

[solutions]
dir = "~/aoc"          # a git repo, created on first use
language = "haskell"   # or "python", "typescript", "go" or "rust"

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

Colours follow your system's light or dark mode, and can use any [Ghostty](https://ghostty.org) theme, matching your terminal if you like, or a base16 theme file placed in Workshop's `themes` folder. Choose them in Settings.

You can switch between Claude Code and Codex, and between models, in the app under Settings, Models. After each edit, the model that made it and how long it took are shown, which makes comparing them easy. To check models against the same set of example utterances, use `workshop eval --model codex:luna`, for example.

Your program reads the puzzle input on stdin and prints the part 1 answer on the first line and the part 2 answer on the second.

## Working from a terminal

Solutions are ordinary files in your solutions repo, so you can also edit and run them at the server with your own editor. Workshop writes a README there with the details. In short:

```sh
workshop run 2024 1            # build and run a solution on your input, as the app does
workshop run 2024 1 --sample   # on the example chosen in the app, checking its answers
eval "$(workshop env)"         # set up a shell, and an editor started from it, as the app runs solutions
```

`workshop env` covers where your helpers and packages are, and any programs installed with mise for the solutions repo.

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding a language or a model CLI.

## Security

Workshop runs code and spends your model subscription, so it only listens on localhost by default and every request needs the token. Use `workshop serve --tailscale` rather than binding to other interfaces.

The model never gets to run commands or change files. With Claude Code, it's given no tools at all. Codex can't be run entirely without tools, so Workshop turns off every tool it can, runs Codex in its read-only sandbox, and stops it, making no edit, the moment it starts to use one.

See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Advent of Code

Workshop caches puzzles and inputs, spaces out its requests, and identifies itself with a User-Agent pointing at this repo, following Advent of Code's guidance for automated tools. Advent of Code asks that puzzle text and inputs aren't published, so Workshop keeps them outside your solutions repo, and the solutions repo's `.gitignore` excludes input files.

## Development

With [mise](https://mise.jdx.dev) installed:

```sh
mise run dev     # rebuild and restart on every change; refresh the page to see it
mise run serve   # an optimised build, for when you're just using Workshop
mise run check   # everything CI runs; check-fast skips the browser tests
mise run build   # a release binary with the frontend embedded
```

Both serve to your phone over Tailscale when it's installed, and keep macOS awake while they run.

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
