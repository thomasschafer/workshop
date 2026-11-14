# Packs

A pack is a directory of things to learn, usually a git repo of its own. Workshop reads it as it is, so you can write and edit items in any editor, and keep your pack private while Workshop stays public. Workshop comes with a small sample pack, in `packs/sample`, which it uses until you configure your own.

What you've done stays in Workshop's own data, never in the pack: attempts, when each item is due again, and cards you've flagged.

## Layout

```
my-pack/
  pack.toml              the pack's name, skills, tracks, goals and prompt add-ons
  items/
    cards/heaps.md       an item in one file
    probability/dice.md
    coding/two-sums/     an item with files of its own, such as solutions
      item.md
      reference.py
      ...
  prompts/
    examiner.md          a prompt add-on
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

# Something to work towards: a set of skills, each to reach a mastery from 0 to 1.
[[goals]]
id = "probability-foundations"
name = "Probability foundations"
skills = ["probability.conditional"]
mastery = 0.8                    # the default
by = "2027-06-30"                # optional

# Text added to a coach role's instructions, to shape its style for this pack.
[prompts]
tutor = "prompts/tutor.md"
examiner = "prompts/examiner.md"
grader = "prompts/grader.md"
author = "prompts/author.md"
```

Every item names at least one skill, and every skill it names must be listed here. Mastery of a skill comes from how well you've recalled its items lately, so goals can show progress as you go.

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
| `kind` | `card`, `mental-maths`, `probability`, `coding` or `design`. Required. |
| `skills` | The skills it practises, from `pack.toml`. Required. |
| `id` | Lowercase letters and digits, in words joined by hyphens. Defaults to the file's name, or the directory's for an `item.md`. Your history is kept by id, so changing it starts the item afresh. |
| `title` | What it's called in lists, if not the start of its prompt. |
| `track` | A built-in track (`review`, `mental-maths`, `probability`, `coding`, `system-design`) or one of the pack's. Defaults by kind. |
| `source` | Where it came from, in your own words, such as for questions imported from elsewhere. Workshop shows it but doesn't interpret it. |
| `minutes` | Roughly how long it takes. Defaults by kind. |

Items that can't be read are left out, and Workshop says which and why. `workshop pack check` finds them too.

### Cards

A question and its answer, which you mark yourself after seeing the answer: Again, Hard, Good or Easy. In the Review track by default.

Sections: `## Answer` (required) and `## Explanation`.

If a card is wrong, flag it in the app with "This is wrong". It's left out of practice until you fix it and clear the flag.

### Mental maths

A template that makes a fresh question each time, with numbers drawn from params and an answer worked out from them. The answer is checked as you type it.

```markdown
+++
kind = "mental-maths"
skills = ["arithmetic.division"]
answer = "b"
require = "b % 10 != 0"    # optional: draw again until this is true
tolerance = 0              # optional: how far off an answer may be, such as for estimates

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

Params are integers, drawn from `min` to `max` inclusive, or from `choices`. `answer`, `require` and derived values are expressions of the params, and derived values can be used in the answer too. Arithmetic on integers stays in integers, so `7 / 2` is 3; write `7.0 / 2` for 3.5. `{name}` in the prompt or the method shows a param's or a derived value's value, and the method can also show `{answer}`. The optional `## Method` section is shown after answering.

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

A problem to solve in code, as a directory with an `item.md` and its files. In the Coding track by default.

```toml
kind = "coding"
skills = ["algorithms.graphs"]
languages = ["python", "rust"]     # what it can be solved in
read_only = ["cpp"]                # languages whose reference can be read, but not written in
reference = ["reference.py", "reference.rs"]
brute_force = "brute.py"           # slow but obviously right
tests = "tests.toml"               # hand-written cases
inputs = "inputs.py"               # prints a random input for the seed it's given
```

The check compares the reference solutions with the brute force on random inputs from `inputs`, and runs the tests against each reference. Sections: `## Hints` and `## Notes`. For now `workshop pack check` checks a coding item's files are in place; running them comes with the Coding track.

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

`## Rubric` is a list, one point per line. `## Notes` is optional.

## Scripts

Mental maths expressions and probability simulations are in [Rhai](https://rhai.rs), a small scripting language much like Rust or JavaScript. Scripts can't read files, import modules or print, and each run is limited in how much it can do. Besides Rhai's own functions, they can use:

| | |
| --- | --- |
| `rand_int(low, high)` | An integer from `low` to `high`, inclusive. |
| `rand_float()` | A number from 0 up to 1. |
| `rand_bool(p)` | `true` with probability `p`. |
| `rand_choice(array)` | One of the array's items. |
| `shuffle(array)` | The array in a random order. |

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

reads every item, runs each one's check, and lists what's wrong, exiting with an error if anything is. Without a path, it checks the packs in your config, or the sample pack if there are none. CI runs it on the sample pack.
