# Workshop

Solve [Advent of Code](https://adventofcode.com) puzzles by voice, from your phone.

Workshop runs on your laptop and you open it on your phone. The phone shows the puzzle and your code; you hold a button and say the code you want, roughly as you'd type it, and a model turns what you said into a precise edit. It's built for working one-handed, away from a desk.

<!-- A short demo GIF of fixing code by voice goes here. -->

Workshop is voice editing, not code generation. "Write a function to sort a list" won't do anything. "Function solve from String to Int", then "solve equals lines", "before that map read dot" and "before that sum dot" gives you `solve = sum . map read . lines`. If Workshop isn't sure what you meant, it makes no edit and tells you why.

Workshop is unofficial and isn't affiliated with Advent of Code.

## What you get

- Puzzle and code side by side, in tabs, with big controls in the thumb zone.
- Edits relative to the cursor: tap to place it, then "before that", "wrap that in parens", and so on. Speech-recognition mistakes like "fold are" for `foldr` are fixed from context.
- Instant voice commands that don't need the model: "undo", "run the sample", "go to line 12", "next error", "snippet starter".
- Inline errors and types from your language server, when you have one.
- Run on the sample, run on your input, and submit, with a check against the sample's expected answer first.
- Discuss mode: a coach that can see the puzzle and your code, won't edit anything, and won't give the answer away unless you ask.
- Notes, snippets, and a commit-and-push button for your solutions repo.
- Everything is saved as you go, so you can put the phone down and pick up where you left off, on the phone or at your desk.

## Requirements

- A model CLI that you're logged in to. Workshop uses [Claude Code](https://claude.com/claude-code) by default, through your existing subscription. Tools are disabled for every call, so the model can only reply with text.
- The toolchain for your language. Haskell is supported first: GHC, plus haskell-language-server for errors and types.
- Your Advent of Code session cookie.
- A way to reach your laptop from your phone over HTTPS, which browsers require for the microphone. [Tailscale](https://tailscale.com) works well.

## Getting started

Download a binary from the [releases page](https://github.com/thomasschafer/workshop/releases), then:

```sh
workshop doctor   # check your setup, with fixes for anything missing
workshop          # start the server and print the link to open
```

To use it from your phone over Tailscale:

```sh
tailscale serve --bg 7878
```

Open the `https://…ts.net` address that prints, adding the `?token=…` part of the link Workshop printed. The token is then remembered by your phone's browser. Keep your laptop awake while you're out, for example with `caffeinate -i` on macOS.

To save your Advent of Code session cookie, log in to the site, copy the `session` cookie from your browser's developer tools, and save it to the `aoc-session` file in Workshop's config directory (`workshop doctor` shows where), or set `AOC_SESSION`.

## Configuration

Workshop writes a commented config file on first run; `workshop doctor` shows where it is. The defaults:

```toml
[server]
bind = "127.0.0.1:7878"

[solutions]
dir = "~/aoc"          # a git repo, created on first use
language = "haskell"

[models.edit]
provider = "claude"
model = "haiku"        # aliases always use the latest version

[models.discuss]
provider = "claude"
models = ["sonnet", "opus", "fable"]

[[snippets]]
name = "parse ints"
body = "map read . lines"
```

Your program reads the puzzle input on stdin and prints the part 1 answer on the first line and the part 2 answer on the second.

See [CONTRIBUTING.md](CONTRIBUTING.md) for adding a language or a model CLI.

## Security

Workshop runs code and spends your model subscription, so it only listens on localhost by default and every request needs the token. Use `tailscale serve` rather than binding to other interfaces. See [SECURITY.md](SECURITY.md) to report a vulnerability.

## Advent of Code

Workshop caches puzzles and inputs, spaces out its requests, and identifies itself with a User-Agent pointing at this repo, following Advent of Code's guidance for automated tools. Advent of Code asks that puzzle text and inputs aren't published, so Workshop keeps them outside your solutions repo, and the solutions repo's `.gitignore` excludes input files.

## Development

With [mise](https://mise.jdx.dev) installed:

```sh
mise run dev     # install dependencies, then run the server with the frontend rebuilding on change
mise run check   # everything CI runs
mise run build   # a release binary with the frontend embedded
```

## Licence

Dual-licensed under [MIT](LICENSE-MIT) or [Apache-2.0](LICENSE-APACHE), at your option.
