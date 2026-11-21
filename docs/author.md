# The author

The author writes new items for a pack of your own: for the skills you're weakest in, those in your goals first, and the kinds of mistake you make most. One model writes them, another run of a model checks each one, and every item must pass its mechanical check, as `workshop pack check` runs it, before it's accepted.

Run it with `workshop author`, or with the Top up button under Packs in the app, or have the server run it by itself on a schedule (see below).

## How a run goes

1. Workshop copies your pack into a directory of its own, leaving out anything hidden, such as `.git`. The writer, by default the newest Opus through Claude Code, works in the copy with tools that can't reach anything else (see below), and writes at most `max_items` new items under `items/`. It's told the pack's format, your weakest skills, your most common kinds of mistake with some examples, the skills whose coding problems, code to read or probability questions you found too easy, with the items you retired and how hard each was, how hard each skill's problems should be, the drafts waiting in `drafts/`, and your answers to its earlier questions. It can make an item from a draft, and delete the draft.
2. Anything else the writer changed in the copy, such as `pack.toml` or an existing item, is put back, and the run's summary says so. Items over the cap are left out.
3. Each new item's check runs. The writer gets `fix_rounds` turns to fix those that fail, and those that still fail are left out. An item that can't be checked on this machine, such as C++ without a compiler, is left out too, as it hasn't been shown to be right.
4. The reviewer (see [Choosing the reviewer](#choosing-the-reviewer)), with no tools, solves each item without seeing its answer, then compares its answer with the item's and says whether the item is right and unambiguous. Where an answer is a number, as for probability and mental maths, Workshop also compares them itself, and a mismatch counts as an objection whatever the reviewer says.
5. If the reviewer objects, the writer can revise the item, which is checked again, or say why it stands, and the reviewer looks again, for up to `discussion_rounds` rounds.
6. Items they agree on are written into your pack and committed, if the pack is a git repo, on whatever branch it's on, with a message listing them. Nothing is ever pushed. Items they still disagree on wait under Packs, Waiting for approval, with the item and what each model said; approving one checks it again before adding and committing it.

The writer can ask you questions, such as which topics you'd like more of. Each goes out as a notification to devices that turned them on, and waits under Packs for your answer, which the next run is told. The run carries on without waiting.

Only one run happens at a time, from the app or the command.

## Harder problems where they're too easy

Rating a coding problem easy retires it, and tells the author to write harder ones for its skills. Each skill has a level from 1 to 5, on the same scale as an item's `difficulty`, worked out from your attempts at its problems: it starts at 3, a problem rated easy lifts it to one above that problem's difficulty if that's higher, and one you forgot lowers it to one below, if that's lower. So a level settles just above what you find easy and below what you forget. The writer is told each skill's level, to write its new problems at that level with their `difficulty` set, and, for skills with problems retired, which ones they were and how hard, so it writes nothing at the same level or easier.

Code to read and probability questions have one fixed answer, which you can come to know by heart, so retiring one after a right answer ("Too easy: retire it") tells the author that too, separately from coding problems. For each skill with such items retired, the writer is told which they were and how hard, and asked for new items of the same kind one level above the hardest of them (as far as 5), with their `difficulty` set, that test the concept differently: different code or a different situation, where it shows up less obviously or alongside another concept, so the answer can't be recalled from the retired ones. A retired item reworded, with its names or numbers changed, or the same question asked of the same code, isn't what's wanted. These don't change the skill's level for coding problems, and answering "Got it", which only sends an item further off, tells the author nothing.

## Settings

Under `[author]` in your config:

```toml
[author]
writer = { provider = "claude", model = "opus" }
# reviewer = { provider = "codex", model = "sol" }   # unset, it's chosen as below
max_items = 5
discussion_rounds = 2
fix_rounds = 2
timeout_minutes = 20
```

### Choosing the reviewer

A reviewer from another provider than the writer's is best. The reviewer's job is to catch the writer's mistakes, and two runs of the same model share its blind spots: a question it misreads, a case it forgets or an answer it's sure of when it's wrong, it's likely to get wrong the same way twice. A different model, trained differently, fails in different places, so it catches more.

Not everyone has two providers, though, so the reviewer can use the writer's own, such as Opus through Claude Code for both. It's still kept apart from the writer: each review is a call of its own, with no tools, that's never told the writer's working or its conversation, and solves each item before it's shown the item's answer. The mechanical checks, and Workshop's own comparison of numeric answers, don't depend on the reviewer at all. What it can't give is a second opinion with different blind spots, so an item one model is wrong about is more likely to get through.

Which reviewer a run uses:

1. The one set as `reviewer` under `[author]`, if there is one, whatever its provider, such as `{ provider = "antigravity", model = "gemini-4-neon-high" }` for Gemini through Antigravity.
2. Otherwise, the first of these that isn't the writer's provider, and whose CLI is installed and logged in: the newest Sol through Codex, then the newest Opus through Claude Code.
3. Otherwise, the writer's own provider and model.

It's chosen as each run starts. Packs, under the author, says which it is and why, and so does `workshop doctor`, which warns when it's the writer's own provider and says what to install for another, as an option, and fails when the one set isn't installed or logged in. To use Claude Code alone, nothing needs setting, or to say so, set:

```toml
[author]
writer = { provider = "claude", model = "opus" }
reviewer = { provider = "claude", model = "opus" }
```

## Running on a schedule

While `workshop serve` is running, it can run the author by itself, for each pack of your own in turn. It's off unless you set how often, under `[author]`:

```toml
[author]
every = "7d"      # a number of hours, days or weeks, such as "12h", "1d" or "2w"
after = "02:00"   # optional: the time of day to wait for, on this computer's clock
```

A run is due `every` after the last one started, whether that was scheduled, from Top up, or from `workshop author`. With `after`, it waits for that time of day once `every` has nearly passed, so a run that starts late, such as after the computer wakes, doesn't push later runs back; `every` must be at least a day then. With no run yet, the first is due straight away, or at the next `after`. The server keeps when it last started a run in its data directory, so restarting it neither runs the author again nor skips a run, and a run that's due while the computer is asleep happens once it wakes. Packs, under Packs, shows when the next run is due.

Scheduled runs are like any other: one at a time, waiting while one from the app or the command is going, with the same `max_items` and checks, and the writer's programs run only in the sandbox. Devices that turned on notifications are told how each run went, or why it failed. The sample pack is built in, so it's never run on.

The writer's provider needs an `[agent]` command, which the built-in Claude Code and Codex providers have. Antigravity has none, so it can review but not write. A pack's `prompts.author` add-on is added to both models' instructions.

## What the writer can reach

The writer is the only role in Workshop with tools. Every other role, the tutor and grader included, runs with tools turned off, as described in the README.

The writer only ever works in the copy of your pack, which has no `.git` or other hidden files, so no repository, hooks or credentials of yours are in it. Workshop itself reads what changed in the copy, keeps only new files under `items/` and deleted drafts, writes those into your pack, and commits them. The models never run git, and nothing is pushed.

How tightly the writer is kept to the copy depends on its CLI:

- **Claude Code** runs in its restricted mode, started in the copy, with only its file tools (Read, Edit, Write, Glob and Grep): it has no tool that runs commands or code, and none that fetches from the web. Restricted mode keeps the file tools to the working directory; edits there are accepted, and anything that would ask permission is refused, as there's nobody to answer. Your own Claude Code settings, MCP servers and slash commands aren't loaded. This is Claude Code's own permission system rather than the operating system's: it relies on Claude Code enforcing it correctly, and settings managed by an administrator for your machine still apply.
- **Codex** runs in its workspace-write sandbox, with the copy as its workspace and no network. The sandbox is the operating system's (Seatbelt on macOS, Landlock on Linux), and stops its commands writing anywhere but the copy, including temporary directories, and reaching the network. It doesn't stop them reading: Codex can read any file your user can, and could put what it reads into an item. Your own Codex config and rules aren't loaded, approvals are off, and its tools besides its shell and file edits are switched off.

Either way, the model is told what to write about, which includes your mistakes and answers, and sends that to its provider, as every role does.

## Running what the writer wrote

Checking an item runs its programs: for a coding problem, the reference solutions, brute force and inputs program the writer wrote, and for a reading item, its code. Workshop builds and runs each of them in the operating system's sandbox, as `workshop pack check` and the Coding track do: Seatbelt, through `sandbox-exec`, on macOS, and [bubblewrap](https://github.com/containers/bubblewrap) on Linux, if it's installed and works. Inside it, a build or run:

- can't reach the network, including other machines, this one's own ports and local sockets, or talk to other programs and services, such as by sending Apple events;
- can only write to a directory of its own, which Workshop makes for that build or run and is also its temporary directory, and to `/dev/null`;
- can read the system's own files, its own directory and the toolchains it needs, such as rustup's, mise's and Xcode's, but not the rest of your home directory, shared temporary directories or other volumes.

A version manager's shim, such as mise's, asdf's or pyenv's `python3`, chooses what to start from files above the directory it's run in, such as a `mise.toml`, which the sandbox may hide. So Python, and Rust's compiler where it may be a shim, are asked outside the sandbox, in the directory builds and runs happen in, which interpreter or compiler they are, and that's what's started inside, able to read the installation it's in.

What it can't stop: a program can still see which files exist, and how big they are, anywhere, as compilers need to look at the directories above theirs; it can read anything outside home and temporary directories that your user can, such as `/etc`; and it can use as much CPU and memory as it likes until its time is up. On Linux, the system's files are mounted read-only rather than limited rule by rule, and home, temporary and runtime directories, such as `/run`, where local services keep their sockets, are replaced with empty ones.

Where there's no sandbox, such as on Windows or on Linux without bubblewrap, the author doesn't run the writer's programs at all: its coding and reading items are left out, as they can't be checked, and approving one waiting under Packs says why it can't be added.

## Running it safely the first time

- Commit or stash anything in your pack first, so the author's commit is easy to look over, and to undo with `git revert` if you don't want it. Workshop only commits the files it writes, and leaves anything else you've staged alone.
- Start small, with `max_items = 1` or 2.
- Look at what it wrote with `git show` before pushing your pack anywhere.
