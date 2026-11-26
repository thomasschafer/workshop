# Setting up Workshop

## Requirements

- [Claude Code](https://claude.com/claude-code), [Codex](https://developers.openai.com/codex) or the [Antigravity](https://antigravity.google) CLI, logged in. Workshop uses your existing subscription.
- Your language's toolchain, or [mise](https://mise.jdx.dev) to install it for you.
- For Advent of Code, your session cookie, which the app asks for.
- A way to reach the server from your phone over HTTPS, which browsers require for the microphone and for working offline. [Tailscale](https://tailscale.com) works well.
- Optionally, [whisper.cpp](https://github.com/ggml-org/whisper.cpp) (`brew install whisper.cpp` on macOS), which hears code more accurately than your phone's speech recognition.

`workshop doctor` checks all of these and tells you how to fix anything missing.

## Installing and starting

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

This gives Workshop an HTTPS address on your tailnet, and prints a link and QR code to open on your phone. Tailscale keeps serving that address once Workshop stops, so from then on `workshop` alone prints the phone link too. If Tailscale already serves Workshop, it reuses that address; otherwise it uses your machine's bare address (port 443). It never takes over a port another app is served on: if 443 is in use, pick another with `--https-port`, such as `workshop serve --tailscale --https-port 8443`. `workshop token --tailscale` takes the same options, and prints the link without starting the server. You can add Workshop to your phone's home screen to open it full screen like an app; on an iPhone, it asks for the link once more, as it doesn't share Safari's login.

The first time you open Workshop, a short setup walks you through choosing your language and model and logging in to Advent of Code. If you'd rather not paste your session cookie into the app, save it to the `aoc-session` file in Workshop's config directory (`workshop doctor` shows where), or set `AOC_SESSION`.

While Workshop is served to your phone, it keeps a Mac awake, so it can still be reached once you've walked away; set `keep_awake = false` under `[server]` to stop this. On other systems, keep the machine awake yourself.

## Your solutions

Your program reads the puzzle input on stdin and prints the part 1 answer on the first line and the part 2 answer on the second.

Solutions are ordinary files in your solutions repo, so you can also edit and run them with your own editor. Workshop writes a README there with the details. In short:

```sh
workshop run 2024 1            # build and run a solution on your input, as the app does
workshop run 2024 1 --sample   # on the example chosen in the app, checking its answers
eval "$(workshop env)"         # set up a shell, and an editor started from it, as the app runs solutions
```

See [CONTRIBUTING.md](../CONTRIBUTING.md) for adding a language or a model CLI.
