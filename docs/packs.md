# Packs

A pack is a directory of things to learn, usually a git repo of its own. Workshop reads it as it is, so you can write and edit items in any editor, and keep your pack private while Workshop stays public. Workshop comes with a small sample pack, in `packs/sample`, which it uses until you configure your own. To keep using it alongside your own, set `sample_pack = true` under `[learning]` in your config.

What you've done stays in Workshop's own data, never in the pack: attempts, when each item is due again, cards you've flagged, and your code and plans for coding problems.

## Layout

```
my-pack/
  pack.toml              the pack's name, skills, tracks, goals and prompt add-ons
  items/
    cards/heaps.md       an item in one file
    probability/dice.md
    coding/pair-sums/    an item with files of its own, such as solutions
      item.md
      reference.py
      ...
    reading/lifetimes.md
  drafts/
    three-dice.md        a question waiting to be made into an item
  prompts/
    examiner.md          a prompt add-on
    examiner-steady.md   an examiner style's add-on
```

Every Markdown file under `items/` is an item, except that a directory holding an `item.md` is one item, and its other files belong to it. Directories under `items/` are only for keeping things tidy; what an item is about comes from its skills. Files and directories starting with `.` are ignored.

## `pack.toml`

```toml
id = "my-pack"          # lowercase letters and digits, in words joined by hyphens
name = "My pack"
description = "What it's for"

[[skills]]
id = "probability.conditional"   # parts separated by dots
name = "Conditional probability"

# Tracks of the pack's own, shown on the home screen after the built-in ones.
[[tracks]]
id = "estimation"
name = "Estimation"
summary = "Quick numbers for back-of-the-envelope sums"
icon = "approximately"           # optional: see below

# Something to work towards: a set of skills, each to reach a mastery from 0 to 1.
[[goals]]
id = "probability-foundations"
name = "Probability foundations"
skills = ["probability.conditional"]
mastery = 0.8                    # the default
by = "2027-06-30"                # optional

# Kinds of mistake for the mistake log, besides the built-in ones.
[[error_types]]
id = "unit-slip"
name = "Unit slip"
description = "Mixed up units, such as seconds and milliseconds"

# Text added to a coach role's instructions, to shape its style for this pack. The tutor gives
# hints on coding problems and asks the follow-up questions in design sessions; the examiner
# runs timed rounds; the grader marks written and spoken work and checks cards; the author
# writes new items (see docs/author.md).
[prompts]
tutor = "prompts/tutor.md"
examiner = "prompts/examiner.md"
grader = "prompts/grader.md"
author = "prompts/author.md"

# Styles the examiner can take in timed rounds, chosen as a round starts. Each style's add-on
# goes after the pack's examiner add-on.
[[examiner_styles]]
id = "steady"
name = "Steady"
description = "Gives a hint when you ask, and asks a follow-up or two"
prompt = "prompts/examiner-steady.md"
```

A track's `icon` is shown beside its name. It's one of the icons the built-in tracks use, `star`, `code`, `dice`, `network`, `timer`, `sigma` and `history`, or one of `layers`, `approximately`, `book`, `chart`, `flask`, `languages`, `lightbulb`, `puzzle`, `radical` and `shapes`. Without one, a pack's track has `layers`.

Every item names at least one skill, and every skill it names must be listed here. Mastery of a skill comes from how well you've recalled its items lately, so goals can show progress as you go.

Mistakes are tagged with a kind of mistake. The built-in kinds are `misread`, `arithmetic-slip`, `off-by-one`, `missed-edge-case`, `wrong-approach`, `concept-gap` and `too-slow`; a pack's `[[error_types]]` add to them, each with an id of its own.

## Items

An item is Markdown with TOML front matter between lines of `+++`. The body starts with the prompt, what the learner is asked, and goes on with sections under `## ` headings, which depend on the item's kind. Use `###` and below for headings within a section.

```markdown
+++
kind = "card"
skills = ["data-structures"]
+++
In a binary heap of n items, what does removing the smallest cost?

## Answer

O(log n).

## Explanation

The last item moves to the root and sinks down one path, which is about log₂ n long.
```

Every item can have:

| Field | |
| --- | --- |
| `kind` | `card`, `mental-maths`, `probability`, `coding`, `reading` or `design`. Required. |
| `skills` | The skills it practises, from `pack.toml`. Required. |
| `id` | Lowercase letters and digits, in words joined by hyphens. Defaults to the file's name, or the directory's for an `item.md`. Your history is kept by id, so changing it starts the item afresh. |
| `title` | What it's called in lists, if not the start of its prompt. |
| `track` | A built-in track (`review`, `mental-maths`, `probability`, `coding`, `system-design`) or one of the pack's. Defaults by kind. |
| `source` | Where it came from, in your own words, such as for questions imported from elsewhere. Workshop shows it but doesn't interpret it. |
| `minutes` | Roughly how long it takes. Defaults by kind. A timed round of it lasts this long, and at least 10 minutes. |

Items that can't be read are left out, and Workshop says which and why. `workshop pack check` finds them too.

### Cards

A question and its answer, which you mark yourself after seeing the answer: Again, Hard, Good or Easy. In the Review track by default.

Sections: `## Answer` (required) and `## Explanation`.

If a card is wrong, flag it in the app with "This is wrong". It's left out of practice until you fix it and clear the flag, under Packs in the app, where the grader can also check it: it unflags a card it finds right, and proposes a fix for one it doesn't, which is written to the card's file, and committed if the pack is a git repo, once you approve it. You can also answer a card in your own words, typed or explained aloud, for the grader to mark; explained aloud, it's marked for how clearly you put it as well as whether it's right.

### Mental maths

A template that makes a fresh question each time, with numbers drawn from params and an answer worked out from them. The answer is checked as you type it.

```markdown
+++
kind = "mental-maths"
skills = ["arithmetic.division"]
answer = "b"
require = "b % 10 != 0"    # optional: draw again until this is true

[params]
a = { min = 3, max = 12 }
b = { choices = [12, 15, 18, 24] }

# Optional: values worked out from the params, for the prompt to show.
[derived]
product = "a * b"
+++
What's {product} ÷ {a}?

## Method

{a} × {answer} = {product}.
```

Answers must be exact unless the template says how close is close enough, which makes it an estimate:

```toml
tolerance = 5               # within 5 either way
relative_tolerance = 0.05   # within 5% of the answer
factor = 2                  # from half to twice the answer, for when only its magnitude matters
```

An answer within any of the bounds given is right. The app shows the bounds with the question, such as "within 5%", and after answering shows the answer to four significant figures, so an estimate's method should teach a quick way to get close, rather than how to get the answer exactly. For a big answer, ask for it in a unit that keeps it short, such as millions or terabytes, as phones offer a keypad of digits for answers.

Params are integers, drawn from `min` to `max` inclusive, or from `choices`. `answer`, `require` and derived values are expressions of the params, and derived values can be used in the answer too. Arithmetic on integers stays in integers, so `7 / 2` is 3; write `7.0 / 2` for 3.5. Scripts can round with `sig(x, n)`, to `n` significant figures, such as for the rounded numbers an estimate works with. `{name}` in the prompt or the method shows a param's or a derived value's value, and the method can also show `{answer}`. The optional `## Method` section is shown after answering.

### Probability

A question with an exact numeric answer, and a simulation that checks it.

````markdown
+++
kind = "probability"
skills = ["probability.counting"]
answer = "1/6"             # a fraction, decimal or percentage
answer_tolerance = 0.005   # optional: how far off, relatively, a learner's answer may be

[simulation]
trials = 100000
tolerance = 0.005          # how far the simulation's estimate may be from the answer
+++
Two fair dice are rolled. What's the probability that they add up to 7?

## Solution

Six of the 36 pairs add up to 7, so it's 1/6.

## Simulation

```rhai
rand_int(1, 6) + rand_int(1, 6) == 7
```
````

The simulation is one trial. It gives `true` or `false` when the answer is a probability, or a number when it's an average, and `workshop pack check` runs it `trials` times and compares the mean with the answer. The tolerance must allow at least three standard errors of the estimate, so the check can't pass or fail by chance; if it doesn't, the check says so and how much it would need. Simulations always start from the same seed, so a check gives the same result every time.

Answers can be typed as fractions, decimals or percentages. `## Solution` (required) is shown after answering.

### Coding

A problem to solve in code, in Python or Rust, as a directory with an `item.md` and its files. In the Coding track by default. Programs read their input on stdin and print their answer; outputs are compared line by line, ignoring whitespace at the ends of lines and blank lines before and after.

```toml
kind = "coding"
skills = ["algorithms.hashing"]
languages = ["python", "rust"]             # what it can be solved in
reference = ["reference.py", "reference.rs"] # a solution known to be right, in each language
starter = ["starter.py", "starter.rs"]       # what the learner starts with, in each language
brute_force = "brute.py"                   # slow but obviously right
inputs = "inputs.py"                       # prints a random input
tests = "tests.toml"                       # examples, and hidden tests
random_inputs = 100                        # optional: how many random inputs the check compares on
```

Each language needs a reference solution and a starter, told apart by their files' extensions: `.py` for Python, `.rs` for Rust. A starter usually reads the input and leaves a function to fill in, so the learner can get straight to the problem on a phone; it must build, unfinished as it is. The brute force and the inputs program can be in either language.

The inputs program is run with two arguments, a seed and a size from 1 to 10, and prints one input. It must make the same input from the same seed, and should make bigger inputs for bigger sizes. Inputs are tried from the smallest size up, so the input a wrong solution is first found failing on, which the learner is shown, is a small one.

`tests.toml` has the examples the learner sees and can run while coding, and the tests kept from them until they submit, at least one of each:

```toml
[[example]]
input = """
5 6
1 5 3 3 2
"""
output = "2"

[[test]]
input = "1 2\n1\n"
output = "0"
```

Sections: `## Approach` (required), how it's meant to be solved, shown once it's solved and when it comes back for review; `## Hints`, a list of nudges from gentlest to most telling, which the learner can reveal one at a time; and `## Notes`.

`workshop pack check` builds and runs everything: the brute force must pass the examples, each reference must pass the examples and tests and agree with the brute force on `random_inputs` random inputs, and each starter must build. It needs Python and Rust installed; an item that can't be run for want of one is reported as skipped rather than failed. Everything is built and run in a sandbox, with no network and writing only to a directory of its own, where the system has one ([docs/author.md](author.md#running-what-the-writer-wrote) says which); where it doesn't, the check warns that it's running the pack's programs with all your access.

A learner works through a problem in steps of a few minutes each: understanding it, by working out what the first example prints; planning, in words, typed, dictated or explained aloud; coding, and running the examples; testing, when it's submitted to the hidden tests and compared with the brute force on random inputs; and reviewing, against the approach and a reference solution, where they can explain their solution aloud for the grader to mark against the approach. When it comes back for review, it's usually to recall the approach: writing down how to solve it, then comparing that with the item's approach, which takes a few minutes rather than solving it again. A problem the learner couldn't solve last time is solved again instead, and they can choose to solve it again any time.

### Reading

Code to read, and a question about it, such as what it prints, what's wrong with it, or what it costs. In the Coding track by default, and short, so it works offline. The prompt shows the code in one code block, whose mark says its language: `python` (or `py`), `rust` (or `rs`), or `cpp` (or `c++`). The code is highlighted for that language, and built and run with its toolchain. C++ is only for reading, not for coding problems.

Either the question is what the code prints, which the learner types:

````markdown
+++
kind = "reading"
skills = ["cpp.semantics"]
prints = "-3 -1"
+++
What does this print?

```cpp
#include <iostream>

int main() {
    std::cout << -7 / 2 << " " << -7 % 2 << "\n";
}
```

## Explanation

Integer division rounds towards zero, and the remainder takes the sign of the number divided.
````

or it's a choice, with `choices` and `answer`, the right one, counting from 1:

```toml
choices = ["Nothing: it prints 1", "It reads memory that's been freed", "It doesn't compile"]
answer = 2

[check]
expect = "sanitizer-error"
```

`## Explanation` (required) is shown after answering.

The check builds and runs the code, as a program of its own. For what it prints, the code must print exactly that. For a choice, `[check]` says what the code must do, and what makes sense depends on its language:

| `expect` | Python | Rust | C++ |
| --- | --- | --- | --- |
| `compiles` | | builds; the default | builds; the default |
| `compile-error` | | fails to build, such as for a borrow the borrow checker refuses | fails to build |
| `runs` | runs to the end without an exception; the default | runs to the end without panicking | runs to the end, exiting successfully |
| `exception` | stops with an exception it doesn't catch | | |
| `panic` | | panics, such as on an integer overflowing | |
| `sanitizer-error` | | | stopped by the address and undefined behaviour sanitizers, such as for reading freed memory |
| `output` | prints the `output` given | prints the `output` given | prints the `output` given |

`output` is for code that shows its answer, such as a count of the copies or moves it makes, to show what it costs. A check that doesn't fit the code's language, such as `compile-error` for Python or `sanitizer-error` for Rust, is refused, with what to use instead. Python isn't built ahead of running it, so a syntax error isn't a compile error, nor an exception the code raises.

Rust code is built as a debug build, as `cargo run` does, so integer overflow panics rather than wrapping around, and `debug_assert!` is checked. C++ is built with optimisations, and with the sanitizers only for `sanitizer-error`, as they change what the code does. Without a C++ compiler (`c++`, `clang++` or `g++`), C++ items are reported as skipped, as are Python and Rust ones without `python3` or `rustc`.

````markdown
+++
kind = "reading"
skills = ["rust.semantics"]
choices = ["It prints 300", "It prints 44", "It panics, as the sum overflows a u8"]
answer = 3

[check]
expect = "panic"
+++
What happens when this runs, in a debug build?

```rust
fn main() {
    let sizes: Vec<u8> = vec![200, 100];
    let total: u8 = sizes.iter().sum();
    println!("{total}");
}
```

## Explanation

A u8 holds 0 to 255, and a debug build checks arithmetic for overflow.
````

### Design

A design prompt, marked against a rubric. In the System design track by default.

```markdown
+++
kind = "design"
skills = ["systems.reliability"]
minutes = 30
+++
Design a service that shortens links.

## Rubric

- Estimates reads and writes per second
- Chooses how short codes are made, and handles collisions
- Says what happens when a store is unavailable
```

`## Rubric` is a list, one point per line. `## Notes` is optional: what a good answer looks like, for the examiner and the grader to judge by. The learner sees the rubric once their work is marked, and never the notes.

A design prompt is worked through as a design session of five stages: clarifying the requirements, estimating the scale, outlining the design as a list of components and what each talks to, going into one of them, and its trade-offs and failure modes. Notes are typed or dictated at each, and the tutor asks follow-up questions about what's been written, which can be answered aloud too. Everything's saved as it's written, so a session can be stopped at any stage and carried on later, and earlier stages gone back to. At the end, the grader marks the whole session against the rubric, which counts as an attempt rated from its score. A session takes a while, so Continue only offers one when the learner has said they've got a while.

## Timed rounds

Coding problems, probability questions and design prompts can also be done as timed rounds, in the Timed rounds track: the problem against a visible clock, as in a live session, with the examiner. The learner keeps their working in one place, typed or dictated, and talks with the examiner as they go; it answers questions without giving the method away and, once they have an answer, asks follow-ups that extend or change the problem. A round lasts the item's `minutes`, and at least 10. When time runs out, or the learner ends it, the grader marks the working and what was said against a rubric: a design prompt's own, and for a coding problem or a probability question, one Workshop has for rounds of each, judged against the item's approach or solution. Answering the examiner's follow-ups well is a point in each. That counts as an attempt, and what the grader finds goes in the mistake log.

Rounds are long, so the track is only on the home screen, and Continue only offers one, when the learner has said they've got a while, or has a round under way. The clock only runs while the round is open in the app. If the app closes or the phone sleeps, the clock stops, and coming back within half an hour carries on where it was, with the examiner told of the break. After longer than that, the sitting is over, so the round ends as it was left: it's marked, and what the grader finds is kept, but it doesn't count as an attempt, as a round cut short says too little about what the learner knows.

The pack's `examiner` add-on applies to every round, and its `[[examiner_styles]]` let the learner choose how the examiner behaves for each: how many hints it gives, how strict it is with time, how hard it probes. The sample pack's two styles show the idea.

## Drafts

A draft is a question added to a pack as it was found, such as from elsewhere, waiting to be made into an item with a check. Drafts are never practised. Add one in the app, under Packs, or with:

```sh
workshop pack import question.md --skills probability.counting --source "Where it's from" --kind probability
```

which reads the question from the file, or from stdin without one, writes it to `drafts/`, and commits it if the pack is a git repo. `--source` is free-form, in your own words, and `--kind` is optional. With more than one pack, say which with `--pack` and its id.

```markdown
+++
source = "Where it's from"
skills = ["probability.counting"]
kind = "probability"
added = "2026-11-14"
+++
Three dice are rolled. What's the chance that they all differ?
```

The author can make an item from a draft, with its check, and removes the draft when it does.

## Scripts

Mental maths expressions and probability simulations are in [Rhai](https://rhai.rs), a small scripting language much like Rust or JavaScript. Scripts can't read files, import modules or print, and each run is limited in how much it can do. Besides Rhai's own functions, they can use:

| | |
| --- | --- |
| `rand_int(low, high)` | An integer from `low` to `high`, inclusive. |
| `rand_float()` | A number from 0 up to 1. |
| `rand_bool(p)` | `true` with probability `p`. |
| `rand_choice(array)` | One of the array's items. |
| `shuffle(array)` | The array in a random order. |
| `sig(x, n)` | `x` rounded to `n` significant figures. |

A trial can end early with `return`, such as when drawing again until a condition holds:

```rhai
loop {
    let first = rand_bool(0.5);
    let second = rand_bool(0.5);
    if first || second { return first && second; }
}
```

## Checking a pack

```sh
workshop pack check ~/my-pack
```

reads every item, runs each one's check, and lists what's wrong, exiting with an error if anything is. Items that can't be checked here, such as C++ without a compiler, are listed as skipped, with what to install, and don't count as wrong. Without a path, it checks the packs in your config, and the sample pack if there are none or `sample_pack` is set. CI runs it on the sample pack.
