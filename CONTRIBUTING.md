# Contributing

Thanks for helping. Bug reports, language profiles and model providers are all especially welcome.

## Development setup

Install [mise](https://mise.jdx.dev), then:

```sh
mise run dev     # install dependencies, then run the server with the frontend rebuilding on change
mise run check   # format, lint, typecheck and test everything, as CI does
```

The Rust server is in `src/` and the TypeScript frontend, built with Vite and CodeMirror 6, is in `frontend/`. The built frontend is embedded in the binary, so users only ever need the one file.

Tests must never use real Advent of Code puzzle text or inputs; invent your own.

Tests don't call model CLIs. If you change the edit prompt (`prompts/edit.md`) or a language's dictation hints, try a handful of utterances by hand and include them in your pull request.

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

Dictation hints matter most. They're given to the edit model with every request, so keep them short, and focus on how the language's operators, chaining and idioms are spoken, and which words speech recognition commonly gets wrong.

## Adding a model provider

A provider describes a model CLI: the command to start it, how to send it the prompt, and how to read its reply. Built-in providers live in `providers/` and are registered in `src/provider.rs`; users can add their own under `[providers.<id>]` in their config.

Every provider must run the model with tools disabled. The edit model must never be able to run commands or change files; it can only reply with text.

Here is a provider for a hypothetical `acme` CLI that reads the prompt on stdin and prints its reply:

```toml
[providers.acme]
command = ["acme", "chat", "--model", "{model}", "--system", "{system_prompt}", "--no-tools"]
# "stdin": the prompt is written to stdin, which is then closed.
# "argument": the prompt replaces a {prompt} placeholder in `command`.
# "claude-stream-json": a Claude Code stream-json user message on stdin.
input = "stdin"
# "text": all of stdout is the reply.
# "claude-json" and "claude-stream-json": Claude Code's JSON output formats.
output = "text"
# Start the next process ahead of time to hide start-up latency. Only for stdin input, and only
# if the CLI waits for stdin rather than giving up when no input arrives quickly.
prespawn = false
version_command = ["acme", "--version"]
# Exits successfully only when logged in; used by `workshop doctor`.
auth_check_command = ["acme", "whoami"]
install_hint = "Install acme from https://example.com, then run `acme login`."

[models.edit]
provider = "acme"
model = "acme-small"
```

Use cheap, fast models for editing, since every utterance is a call. For a new input or output format, add a variant to `InputMode` or `OutputMode` in `src/provider.rs` with tests for its parsing.

## Pull requests

- Keep changes focused, and describe what changes for users.
- Run `mise run check` before opening the pull request.
- Releases are automated: version bumps and the changelog come from a release pull request, so don't edit the version or `CHANGELOG.md` by hand.
