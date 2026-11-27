# Configuration

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
daily_lessons = 1       # the most lessons offered in practice in a day
weekly_minutes = 90     # the week's target
desired_retention = 0.9 # how likely you should be to remember an item when it comes back

[[snippets]]
name = "parse ints"
body = "map read . lines"
```

With a keyboard, the code editor can use [Helix](https://helix-editor.com)'s modal keybindings instead of its own: turn them on for a device under Settings, Display, or for every device with `keybindings = "helix"` under `[editor]`. Your own Helix keymaps and the Helix options Workshop follows go under `[editor.helix]`, in the same format as Helix's config; the commented config file lists them. Commands that work across files, splits and shell commands aren't available, and say so if you press them. On a phone or tablet they come with Workshop's own keyboard in place of the phone's: a laptop's keys, with Escape, Ctrl, Alt and a number row, and the letters where Gboard has them. A touch presses the nearest key, and the keyboard learns where you touch each one as you type; Settings, Display has a minute's typing that measures it outright.

The code is formatted, by the language server or for Python by Ruff, before each run and, with Helix's keybindings, once it's been left in normal mode for a few seconds after a change. Only what formatting changes is touched, so the cursor stays where it was, and undoing a format keeps it undone. Shift-Alt-F, or `:format` and `=` in Helix, formats whenever you like; `format_automatically = false` under `[editor]` turns the rest off.

An error the language server reports itself, rather than in the code, shows as "server error" above the code; tap it to read the whole message with the code's problems. The language server can be restarted from there, or with `:lsp-restart` in Helix.

With a keyboard there are shortcuts for running, zen mode, going straight to a tab or turning between them, and moving the puzzle, whichever keybindings the code has. The keyboard button at the top lists them, as do the help and Cmd-Shift-/ on a Mac or Ctrl-Shift-/ elsewhere, and hovering over a button shows its shortcut. On a wide screen the puzzle sits in a column beside the code; the button at the start of the tabs, or Alt-\, makes it a tab of its own, for more room for the code, and puts it back. On a touch screen, two fingers swept sideways turn to the next tab or back.

Workshop checks once a day for a newer release; set `check_for_updates = false` under `[server]` to turn this off.
