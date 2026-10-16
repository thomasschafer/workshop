# Contributing

Thanks for helping. Bug reports, language profiles and model providers are all especially welcome.

## Development setup

Install [mise](https://mise.jdx.dev), then:

```sh
mise run dev     # rebuild and restart on every change; refresh the page to see it
mise run check   # format, lint, typecheck and test everything, as CI does
```

The Rust server is in `src/` and the TypeScript frontend, built with Vite and CodeMirror 6, is in `frontend/`. The built frontend is embedded in the binary, so users only ever need the one file.

Tests must never use real Advent of Code puzzle text or inputs; invent your own.

Tests don't call model CLIs. If you change the edit prompt (`prompts/edit.md`) or a language's dictation hints, run the edit evals before and after, and include the summaries in your pull request:

```sh
mise run eval                             # every case in evals/
cargo run -- eval --filter before-that    # just the cases whose names match
```

Each case is one call to your edit model, so the evals aren't part of CI. When you find an utterance that goes wrong, add it as a new case to the file for its language in `evals/`. A new language profile should come with its own eval file.

When a change alters what the demo shows, re-record `docs/demo.gif` with `mise run demo`. It plays an invented puzzle on an emulated phone, with simulated speech, and makes a few calls to your edit model.

## Adding a language profile

A language profile tells Workshop how to lay out, build and run solutions, which language server to start, and how the language is spoken. Built-in profiles live in `languages/` and are registered in `src/language.rs`. You can also add one in your own config file under `[languages.<id>]` without changing Workshop.

Here is a Python profile as a worked example. As a built-in, it would be `languages/python.toml`:

```toml
name = "Python"
# Syntax highlighting mode, registered in frontend/src/editor.ts.
editor_mode = "python"
lsp_language_id = "python"

# Relative to the solutions directory.
file = "{year}/day{day:02}.py"

# No build step. The puzzle input arrives on stdin; print the part 1 answer on the first line
# and the part 2 answer on the second.
run = ["python3", "{file}"]

lsp = ["pyright-langserver", "--stdio"]

template = '''
import sys


def part1(data: str) -> int:
    raise NotImplementedError


def part2(data: str) -> int:
    raise NotImplementedError


data = sys.stdin.read()
print(part1(data))
print(part2(data))
'''

dictation_hints = '''
- "dot" between names is attribute access `.`; "call" or "of" means call: "len of lines" is `len(lines)`.
- "for x in y colon" starts a loop; "new line" continues at the current indentation, "dedent" goes out one level.
- "list comp x for x in y" is `[x for x in y]`.
- Common mishearings: "in put" is `input`, "split lines" is `splitlines`.
'''
```

Then:

1. Register the file in `BUILTIN` in `src/language.rs`.
2. Add the syntax mode to `LANGUAGES` in `frontend/src/editor.ts`. CodeMirror's `@codemirror/legacy-modes` has modes for most languages, and some have a dedicated `@codemirror/lang-*` package.
3. Add edit eval cases in `evals/`, registered in `src/eval.rs`, and check them with `mise run eval`.
4. Check it works with the real toolchain: add a case to `frontend/scripts/check-languages.ts` and run `mise run check-languages -- <id>`.

Commands are lists of arguments, not shell strings. The placeholders are `{file}`, `{dir}` (the solution's directory), `{build_dir}` (a scratch directory outside the solutions repo, for build output), `{year}` (`practice` for the practice puzzle) and `{day}`; `{day:02}` pads with zeros. An unknown placeholder is an error. Commands run in the solution's directory.

`lsp_options` is sent to the language server as it starts, for servers that need settings to work at all, such as Deno's `{ enable = true }`. `gitignore` lists lines added to the solutions repo's `.gitignore` with the first solution, for build output written inside it, such as Cargo's `/target/`.

### Starting part 2

Templates usually leave part 2's output commented out. `start_part_two` says how to turn it on, so once part 1 is solved Workshop can offer to, and "start part two" does it by voice:

```toml
start_part_two = { find = """
    # When you start part 2, uncomment the next line.
    # print(part2(data))""", replace = """
    print(part2(data))""" }
```

`find` must appear in the template exactly; a test checks the built-in profiles.

### Helpers

A `[helpers]` table gives solutions a module of the user's own to share. Workshop creates it, along with any settings the language server needs to find it, before the language server first starts, but never replaces files the user already has. Those settings can also make the solutions a project, as `go.mod` and `Cargo.toml` do. Commands can use its directory as `{helpers}`, such as `-i{helpers}` for GHC.

`definition` is a pattern matching a line that defines a helper, with the helper's name as its only group. When the user names a helper, the edit model is shown that line, so it knows how to call the helper and imports it.

```toml
[helpers]
file = "lib/aoc.py"
definition = "^def ([A-Za-z_][A-Za-z0-9_]*)\\("
environment = { PYTHONPATH = "{helpers}" }
lsp_config = { file = "pyrightconfig.json", text = """
{
  "extraPaths": ["lib"]
}
""" }
template = '''
"""Helpers your solutions can share."""
'''
```

If the packages' environment sets the same variable, the values are joined with `:`.

### Packages

If solutions in the language commonly need packages beyond its standard library, add a `[packages]` table. Workshop keeps the list in a manifest in the solutions directory, installs it into a directory of its own (`{env}`), and gives building, running and the language server the environment variables you set. When an error says a module is missing, it offers to install the package that provides it.

```toml
[packages]
manifest = "python-packages.txt"
defaults = []
# Install every package in the manifest into an empty {env}. An argument that is exactly
# {packages} becomes one argument per package.
install = [
  ["python3", "-m", "venv", "{env}/venv"],
  ["{env}/venv/{venv_bin}/python", "-m", "pip", "install", "{packages}"],
]
# {PATH} is Workshop's own PATH. For what differs on Windows, {path_sep} separates directories in
# PATH (`:`, or `;` on Windows), and {venv_bin} is where a Python virtual environment keeps its
# programs (bin, or Scripts on Windows).
environment = { PATH = "{env}/venv/{venv_bin}{path_sep}{PATH}", VIRTUAL_ENV = "{env}/venv" }
# Each pattern has one group: the missing module.
missing_module = ["No module named '([A-Za-z0-9_.]+)'"]
# Patterns for compilers that name the package itself, with the package as their only group.
missing_package = []
# Whether `numpy.linalg` comes from the package `numpy` when no provider below says otherwise.
package_named_after_module = true
# Where to look up a package for a module with no provider listed: "pypi" checks the package
# named after the module exists, "hoogle" searches Hackage for the module, and "crates_io" looks
# up the crate named after it.
lookup = { service = "pypi" }
# Optional: refreshes the installer's package index when it's older than this, or when an
# install fails without it.
# update = { command = ["cabal", "update"], every_hours = 24 }

[packages.providers]
"yaml" = "pyyaml"
```

When the language has a manifest of its own that its tools keep, and fetch what's in it as they build, use that instead, so there's one list and it's where the language's users expect it. `format` says how to read it (`cargo`, `go-mod` or `deno`), and `add` and `remove` are the commands that change it, run in the solutions directory with the package as `{package}`. There's no `{env}` and nothing to install, so `defaults`, `environment` and `update` don't apply:

```toml
[packages]
manifest = "Cargo.toml"
format = "cargo"
add = [["cargo", "add", "{package}"]]
remove = [["cargo", "remove", "{package}"]]
missing_module = ["unresolved import `([A-Za-z0-9_]+)`"]
lookup = { service = "crates_io" }
```

A manifest like this usually makes the solutions a project, so write it with the helpers' `lsp_config`, which exists before the language server starts.

The patterns are matched in the browser too, so keep to regex syntax that Rust and JavaScript share. Make sure the language server picks up the environment. Installer output is shown as it happens and kept for the user to read, so a failure should explain itself there.

`mise run check-packages [-- <id>...]` checks the built-in profiles against the real toolchains: a missing module is found, looked up, installed, and then seen by the language server and the solution. It needs the network, so it isn't part of CI; run it when you change how packages work.

### Toolchain

A `[toolchain]` table lets setup install the language's programs with [mise](https://mise.jdx.dev) when they're missing. Workshop writes `mise` to the solutions directory as `mise.toml`, unless the directory has a mise config already, then runs `mise install` and any `after_install` commands there. Building, running, installing packages and the language server then happen in that environment, as does `workshop env`. Prefer mise's own tools; when one isn't good enough, install it with another installer, keeping everything inside the solutions directory, as the Haskell profile does with ghcup.

```toml
[toolchain]
mise = '''
[tools]
python = "3.13"
node = "lts"
"npm:pyright" = "latest"
'''
# Run in the solutions directory after `mise install`.
after_install = []
# Added to the solutions repo's .gitignore, for anything installed inside it.
gitignore = []
```

Dictation hints matter most. They're given to the edit model with every request, so keep them short, and focus on how the language's operators, chaining and idioms are spoken, and which words speech recognition commonly gets wrong.

## Adding a model provider

A provider describes a model CLI: the command to start it, how to send it the prompt, and how to read its reply. Built-in providers live in `providers/` and are registered in `src/provider.rs`; users can add their own under `[providers.<id>]` in their config.

Besides `{model}` and `{system_prompt}`, `command` can use `{system_prompt_file}`, the path of a file holding the system prompt, for CLIs that read their instructions from a file, and `{effort}`.

Every provider must run the model with tools disabled. The edit model must never be able to run commands or change files; it can only reply with text.

Here is a provider for a hypothetical `acme` CLI that reads the prompt on stdin and prints its reply:

```toml
[providers.acme]
command = ["acme", "chat", "--model", "{model}", "--system", "{system_prompt}", "--no-tools"]
# "stdin": the prompt is written to stdin, which is then closed.
# "argument": the prompt replaces a {prompt} placeholder in `command`.
# "claude-stream-json": a Claude Code stream-json user message on stdin.
# "ollama-chat": an Ollama /api/chat request body on stdin, for a command such as curl.
input = "stdin"
# "text": all of stdout is the reply.
# "claude-json" and "claude-stream-json": Claude Code's JSON output formats.
# "codex-json": Codex's `exec --json` events. The call is stopped if the model uses a tool.
# "ollama-chat": an Ollama /api/chat response.
output = "text"
# Start the next process ahead of time to hide start-up latency. Only for stdin input, and only
# if the CLI waits for stdin rather than giving up when no input arrives quickly.
prespawn = false
version_command = ["acme", "--version"]
# Exits successfully only when logged in; used by `workshop doctor`.
auth_check_command = ["acme", "whoami"]
install_hint = "Install acme from https://example.com, then run `acme login`."
# How the provider appears in the app's Settings, Models, and the models it offers there.
name = "Acme"
edit_models = ["acme-small", "acme-large"]
discuss_models = ["acme-large"]
# Optional: fills an {effort} placeholder in `command`, separately for edits and discussion.
# effort = { edit = "low", discuss = "high" }

[models.edit]
provider = "acme"
model = "acme-small"
```

A local model through [Ollama](https://ollama.com) works the same way, with no subscription and no network:

```toml
[providers.ollama]
command = ["curl", "-sS", "--fail-with-body", "http://127.0.0.1:11434/api/chat", "-d", "@-"]
input = "ollama-chat"
output = "ollama-chat"
```

Check one with `workshop eval` before relying on it. On a 16 GB M2 Pro, Qwen2.5-Coder 7B and 14B made far more wrong edits than Haiku, and the 14B was also slower, so larger models on bigger machines are the ones worth trying.

Use cheap, fast models for editing, since every utterance is a call. If the CLI can name its models (as `codex debug models` does), set `model_catalog` to that command, and a family name such as "luna" will always mean the newest model in the family. See `providers/codex.toml` for a preset built this way. For a new input or output format, add a variant to `InputMode` or `OutputMode` in `src/provider.rs` with tests for its parsing.

## Pull requests

- Keep changes focused, and describe what changes for users.
- Run `mise run check` before opening the pull request.
- Releases are automated: version bumps and the changelog come from a release pull request, so don't edit the version or `CHANGELOG.md` by hand.
