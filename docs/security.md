# Security

Workshop runs code and spends your model subscription, so it only listens on localhost by default and every request needs the token. Use `workshop serve --tailscale` rather than binding to other interfaces.

The model never gets to run commands or change files, except the author's writer, below. With Claude Code, it's given no tools at all. Codex can't be run entirely without tools, so Workshop turns off every tool it can, runs Codex in its read-only sandbox, and stops it, making no edit, the moment it starts to use one. Antigravity can't either, and its own permission settings don't stop its shell, so each call runs in a directory of its own with a hook there that refuses every tool before it runs, and Workshop stops it, using none of its reply, if a tool ever runs anyway. Your own global Antigravity config still applies, though, tools staying refused: its rules, in `~/.gemini/AGENTS.md`, its hooks and its MCP servers. Antigravity doesn't work with Workshop on Windows yet.

The author's writer is the only model with tools, and only in a copy of your pack: with Claude Code, just its file tools, in its restricted mode; with Codex, in its workspace-write sandbox with no network. [author.md](author.md) says what each guarantees, and what it doesn't.

See [SECURITY.md](../SECURITY.md) to report a vulnerability.

## Advent of Code

Workshop caches puzzles and inputs, spaces out its requests, and identifies itself with a User-Agent pointing at this repo, following Advent of Code's guidance for automated tools. Advent of Code asks that puzzle text and inputs aren't published, so Workshop keeps them outside your solutions repo.
