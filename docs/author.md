# The author

The author writes new items for a pack of your own: for the skills you're weakest in, those in your goals first, by the lower of how much of each is covered and how well it's recalled, as the Goals page orders them, and the kinds of mistake you make most. One model writes them, another run of a model checks each one, and every item must pass its mechanical check, as `workshop pack check` runs it, before it's accepted.

Run it with `workshop author`, or with the Top up button under Packs in the app, or have the server run it by itself on a schedule (see below).

## How a run goes

1. Workshop copies your pack into a directory of its own, leaving out anything hidden, such as `.git`. The writer, by default the newest Opus through Claude Code, works in the copy with tools that can't reach anything else (see below), and writes at most `max_items` new items under `items/` (a lesson together with its accompanying new items counts as one towards `max_items`). It's told the pack's format, any requests for lessons from "Teach me" (which come first), how many lessons each targeted skill has, how many of its short items have none, and which of its topics no lesson teaches yet, your weakest skills, with how much of each is covered and how well it's recalled, your most common kinds of mistake with some examples, the skills whose coding problems, code to read or probability questions you found too easy, with the items you retired and how hard each was, how hard each skill's problems should be, the drafts waiting in `drafts/`, and your answers to its earlier questions. It can make an item from a draft, which is removed once the item is accepted.
2. The writer may change existing short items in one way only: adding or changing `lesson` and `segment` in their front matter to link them to a lesson written in the same run. Anything else the writer changed in the copy, such as `pack.toml`, another part of an existing item, or a link to a lesson that isn't kept, is put back, and the run's summary says so. Items over the cap are left out.
3. Each new item's check (and each linked existing item's check) runs. The writer gets `fix_rounds` turns to fix those that fail, and those that still fail are left out. An item that can't be checked on this machine, such as C++ without a compiler, is left out too, as it hasn't been shown to be right. If a lesson fails its check, its accompanying items are left out and links to it are put back; if fewer than three of its accompanying items remain, the lesson is left out too.
4. The reviewer (see [Choosing the reviewer](#choosing-the-reviewer)), with no tools, solves each practice item without seeing its answer, then compares its answer with the item's and says whether the item is right and unambiguous. Where an answer is a number, as for probability and mental maths, Workshop also compares them itself, and a mismatch counts as an objection whatever the reviewer says. For a lesson, the reviewer audits the lesson and its accompanying items rather than solving it blind (see [Lessons](#lessons)); its accompanying items are still reviewed blind.
5. If the reviewer objects, the writer can revise the item or lesson, which is checked again, or say why it stands, and the reviewer looks again, for up to `discussion_rounds` rounds.
6. Items they agree on, along with existing items linked to accepted lessons, are written into your pack and committed, if the pack is a git repo, on whatever branch it's on, with a message listing both the added and the linked items. Nothing is ever pushed. Items they still disagree on wait under Packs, Waiting for approval, with the item and what each model said; a lesson waiting for approval holds its accompanying items and links with it, and approving it checks all of them again before adding and committing them.

The writer can ask you questions, such as which topics you'd like more of. Each goes out as a notification to devices that turned them on, and waits under Packs for your answer, which the next run is told. The run carries on without waiting.

Only one run happens at a time, from the app or the command.

## Lessons

The author writes short lessons (as [docs/packs.md](packs.md#lessons) describes) when you request one with "Teach me" on a short item that has none yet, when a targeted skill has topics no lesson teaches yet, or when a targeted skill's items assume knowledge no lesson in the pack teaches. Requests come first: each requested item is given to the writer with its prompt, answer, explanation and skills, so it can write a lesson (possibly one lesson for several related items) and link them to it. For a skill outlined in topics, the writer is given each topic no lesson teaches yet, and asked to teach those, one topic a lesson, and to give every lesson it writes for such a skill the `topic` it teaches, so its coverage can grow. Once an item names a lesson, its request is answered and "Teach me" opens that lesson instead; a request for an item removed from the pack is dropped. Waiting requests are listed under Packs, under the author.

To keep LLM-written lessons trustworthy, every factual claim must come from a primary source listed in `[[sources]]` (manual pages, official documentation, standards or well-known textbooks), prose stays concise and phone-first (at most six segments, aiming for 180 words or fewer each, with simple `currentColor` SVG diagrams whose labels don't overlap shapes), and behaviour that varies by version or configuration is stated plainly. Anything runnable that a lesson describes should be backed by a code-to-read item whose check actually runs it.

Each lesson is written as a bundle with between three and six new short items that name it with `lesson` (and `segment` where one segment covers them), of varied kinds where the skill suits them. A lesson and its items count as one towards `max_items`. If the lesson is left out — because its check fails after the fix rounds, or because the writer and reviewer don't agree and it waits for approval — its items are left out with it (held with it in Waiting for approval when disagreed), and any links from existing items to it are put back. An individual item left out doesn't take the lesson with it unless fewer than three remain.

Because a lesson has nothing to solve blind, the reviewer audits it instead, given the lesson (including SVG diagram source) and its accompanying items, still with no tools: it checks every factual claim, objecting to any it believes wrong or misleading and to any it isn't sure of that's stated as certain; each guess's and check's answer and explanation; the `## Explain answer`; that the sources appear real and relevant without fetching them; and that any SVG diagram shows what the text says. Any objection goes through the same discussion rounds with the writer as practice items, and the lesson's items are still solved and reviewed blind.

## Problems in parts, and in API mode

The writer can write coding problems in parts, where each part adds requirements to the last and the learner keeps their code from one to the next, and problems in API mode, where the learner writes a class or functions in Python that the tests call, as [docs/packs.md](packs.md#problems-in-parts) describes. They suit skills about designing code that's easy to change, such as data structures with state, an editor's buffer or an inventory, more than a single algorithm. Every part must pass its check, as `workshop pack check` runs it: each part's references must pass its tests and the earlier parts' it doesn't replace, and agree with the brute forces that apply. The reviewer solves the whole problem, every part, blind.

## Work in a codebase

The writer can write codebase items too, as [docs/packs.md](packs.md#work-in-a-codebase) describes: a small project in Python with a bug to fix from its symptom, a change to review with defects planted in it, or code that's hard to test to refactor and then extend. They suit skills about working in code that isn't one's own, such as debugging, reviewing and refactoring, more than ones about a single algorithm. A fix must have hidden tests the project as it's given fails, and a reference fix that passes them; a review's change must apply to its project, with each defect where it says; and a refactor's first part must have given tests the project as it's given fails, while passing its own tests, with each part's reference passing every test that applies. The reviewer sees the project, and for a review the change, and says what it would do, blind.

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

The writer only ever works in the copy of your pack, which has no `.git` or other hidden files, so no repository, hooks or credentials of yours are in it. Workshop itself reads what changed in the copy, keeps only new files under `items/`, front-matter `lesson` and `segment` links on existing short items pointing to accepted lessons written in the same run, and deleted drafts, writes those into your pack, and commits them. The models never run git, and nothing is pushed.

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
