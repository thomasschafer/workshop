+++
kind = "coding"
title = "A text buffer with undo"
skills = ["data-structures"]
difficulty = 2
minutes = 25

languages = ["python"]
reference = ["reference.py"]
starter = ["starter.py"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"

[api]
class = "TextBuffer"

[[parts]]
reference = ["undo/reference.py"]
brute_force = "undo/brute.py"
inputs = "undo/inputs.py"
tests = "undo/tests.toml"

[[parts]]
reference = ["redo/reference.py"]
brute_force = "redo/brute.py"
inputs = "redo/inputs.py"
tests = "redo/tests.toml"
+++
Write a `TextBuffer` class for the text typed into an editor. It starts empty, and has three
methods:

- `insert(text)` adds `text` to the end.
- `delete(count)` removes the last `count` characters, or all of them if there are fewer.
- `text()` returns the text as it is now.

`insert` and `delete` return nothing.

## Part 2

Add `undo()`, which reverses the latest `insert` or `delete` that hasn't been undone yet, and
returns nothing. Each call undoes one more, back to the empty buffer; with nothing left to
undo, it does nothing. A `delete` that removed nothing still counts as a change, which undoing
leaves the text as it is.

## Part 3

Add `redo()`, which puts back the latest change that was undone, and returns nothing. Several
undos can be redone in turn, the latest first. An `insert` or `delete` after undoing leaves
nothing to redo, and with nothing to redo, `redo()` does nothing.

## Approach

Keep the text as a list of characters, so adding to the end and removing from it take time in
proportion to the change, not the whole text.

For undo, keep a stack of changes, each with what reversing it needs: for an insert, how many
characters it added, and for a delete, the characters it removed. Undoing pops the latest and
reverses it. Keeping copies of the whole text after every change works too, but costs time and
memory in proportion to the text at every change.

For redo, keep a second stack, of changes undone: undoing moves a change onto it, redoing moves
it back and makes it again, and a new insert or delete empties it. Every operation is then in
proportion to the size of its change.

## Hints

- A delete can ask for more characters than there are.

## Part 2 hints

- What do you need to remember about a change to reverse it?
- For a delete, keep the characters it removed, not only how many.

## Part 3 hints

- An undone change isn't gone: where could it wait to be made again?
- What should happen to the changes waiting to be redone when something new is typed?
