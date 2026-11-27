# Learning in Workshop

## The home screen

Workshop opens on a home screen, whose Continue button goes straight to the most sensible next step, such as the puzzle you were last working on or the cards due for review. Below it are the tracks: Advent of Code, Coding, and tracks of short items from a pack. A pack's own track can keep to itself, so Continue never offers it and it has limits of its own, for something you only practise when you open it. Everything takes a few minutes at a time unless you turn on "I've got a while", which lets Continue offer long items too: design sessions and timed rounds, taking turns, though one you've left unfinished always comes first. It stays on while you're using the app, and turns itself off once you've been away for half an hour.

## Advent of Code

Pick a year and a day, and Workshop fetches the puzzle and your input. Choose which example is the sample, then write your solution in the editor, run it on the sample and on your input, and submit, with inline errors and types from your language server. Haskell, Python, TypeScript, Go and Rust are built in, and other languages can be added in your config. Alongside the code are notes, snippets, and a discuss tab: a coach that sees the puzzle and your code, and won't give the answer away unless you ask. Solutions can be committed to git after each star; [setup.md](setup.md#your-solutions) says how to run them from your own editor too.

To try it before logging in, or outside December, open the practice puzzle from the bottom of the puzzle list.

## Packs and practice

Besides Advent of Code, Workshop practises short items from a pack: review cards you mark yourself, mental maths with fresh numbers each time, and probability questions with exact answers. A pack is a directory of Markdown files, usually a git repo of your own; [packs.md](packs.md) describes the format. Until you configure one, Workshop uses its small sample pack.

Practice runs straight from one item to the next until there's nothing left in the track for now, showing how many you've done in this sitting and this week's minutes above each item. Each answer is saved as you give it, so you can stop at any moment. Items come back when you're due to forget them, scheduled with [FSRS](https://github.com/open-spaced-repetition/fsrs4anki/wiki/The-Algorithm). Continue puts due reviews first, up to a daily limit, and the home screen counts your practice towards a weekly target rather than a streak.

Short items work offline: once a phone has opened Workshop, it keeps what it needs to practise, and syncs your answers when it can reach the server again. As it keeps the app itself too, a phone carries on with the version it opened until it's reloaded: once a newer one is ready, a card at the top offers to reload, and coming back to the app after a while reloads it by itself, at home or on a puzzle with nothing under way.

## Coding

The Coding track has problems to solve in Python, Rust or Haskell, fully on a phone, and code to read in Python, Rust, Haskell or C++. A problem is a chain of short steps: understand it, by working out what an example prints; plan, typed or dictated; code, in Workshop's editor, with Helix's keybindings and Workshop's own keyboard if you like, and the language server; then submit it, to hidden tests and a comparison with a slow but sure solution on random inputs, which shows you a small input it fails on if it's wrong. Last, compare it with how it's meant to be solved, and say how it went. Each step is saved as you go, your code included, so you can stop at any moment and Continue picks up where you were, on any device. If the problem's language, or its language server, isn't installed, a problem in it offers to install it with mise, for the Coding track only. It also has work in a codebase someone else wrote, a small project of a few files to switch between: fixing a bug from its symptom, reviewing a change by commenting on its lines, or refactoring code so tests can be written for it, then extending it.

A tutor gives hints that don't give the problem away, through your discussion model. Problems come back for review as a short twist on them, posed by the tutor and marked by the grader, or solved again if they went badly; a problem you rate easy is retired, and the author writes harder ones in its skills. Code to read asks what it prints, what's wrong with it or what it costs, and works offline; running code and the tutor need the server. Answered right, code to read or a probability question can be retired as too easy, so it isn't learnt by heart, and the author writes harder variants of it.

`workshop pack check` checks every item in a pack: that it can be read, that a probability question's simulation agrees with its answer, that a mental maths template makes sensible questions, that a coding problem's solutions pass its tests and agree with its brute force on random inputs, and that code to read does what its answer says.


## Design sessions and timed rounds

A design prompt is worked through as a session in stages, from the requirements to the trade-offs. You find out the requirements and the scale by asking the coach, which answers from a brief you see only at the end, then it asks you follow-up questions about your design, and the grader marks the whole session, and what you asked, at the end. Each stage is saved as you write, so you can stop at any of them.

A timed round puts a coding problem, a probability question or a design prompt against a visible clock, with an examiner who answers your questions and asks follow-ups that extend or change the problem, as a live session would. When time's up, the grader marks your working and what was said. The clock only runs while the round is open: close the app and come back within half an hour, and it carries on where it was; leave it longer, and the round ends there and is marked on what you did, without counting as an attempt. A pack can offer styles for the examiner, such as how many hints it gives and how hard it probes, to choose from as a round starts.

Cards, coding plans and solutions, design notes and what you say to the coaches can all be dictated, and some can be explained aloud: the grader then marks how clearly you put it, as well as whether it's right.

A card answered in your own words can go deeper: the tutor asks a few follow-up questions about what you said, such as why it's so or what happens in an edge case, and the grader marks the whole exchange for how deeply you understand it. Each answer is saved as you give it, so you can close the app part-way and carry on.

## Mistakes, goals and the grader

Wrong answers, failed submissions and what the grader finds go into a mistake log, each tagged with a kind of mistake, such as an off-by-one or a misreading, which you can confirm or change; a pack can add kinds of its own. Practice, and Continue, lean towards the skills your recent mistakes are in. Each goal a pack defines has a page showing its skills against the goal's target, how it's changed over the last few weeks, how long is left, and what's weakest.

The grader, through your discussion provider's first model unless you give it one of its own under Settings, Models, or `[models.grader]` in your config, marks written and spoken work against a rubric: design sessions, timed rounds, a coding problem's plan and how its solution works, and a card answered in your own words, with any follow-up questions on it. Its score counts towards scheduling and mastery, and what it finds goes in the mistake log. It also checks cards you've flagged with "This is wrong", unflagging those that are right, and proposing a fix for those that aren't, which changes your pack once you approve it.

The author writes new items for a pack of your own, for what you're weakest in and the mistakes you make most: one model writes them, a model from another provider solves each blind and reviews it, and each must pass its check. Run it with `workshop author`, or Top up under Packs in the app, or have the server run it every so often, with `every` under `[author]`; [author.md](author.md) describes it. Questions you've found elsewhere can be added to a pack as drafts, under Packs or with `workshop pack import`, for the author to make into items.
