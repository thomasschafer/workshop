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
3. Check it works: `workshop doctor` should find the runner, and running the template on a sample should print two lines (or a clear error).

Commands are lists of arguments, not shell strings. The placeholders are `{file}`, `{dir}` (the solution's directory), `{build_dir}` (a scratch directory outside the solutions repo, for build output), `{year}` and `{day}`; `{day:02}` pads with zeros. An unknown placeholder is an error.

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
  ["{env}/venv/bin/python", "-m", "pip", "install", "{packages}"],
]
# {PATH} is Workshop's own PATH.
environment = { PATH = "{env}/venv/bin:{PATH}", VIRTUAL_ENV = "{env}/venv" }
# Each pattern has one group: the missing module.
missing_module = ["No module named '([A-Za-z0-9_.]+)'"]
# Whether `numpy.linalg` comes from the package `numpy` when no provider below says otherwise.
package_named_after_module = true

[packages.providers]
"yaml" = "pyyaml"
```

The patterns are matched in the browser too, so keep to regex syntax that Rust and JavaScript share. Make sure the language server picks up the environment, and that a failed install leaves a clear message: the last lines of the installer's output are shown to the user.

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
