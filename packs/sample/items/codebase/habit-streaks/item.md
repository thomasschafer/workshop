+++
kind = "codebase"
task = "refactor"
title = "Testing habit streaks"
skills = ["refactoring"]
difficulty = 3
minutes = 25

project = "project"
given = ["clock/test_tracker_clock.py"]
tests = ["clock/test_tracker_hidden.py"]
reference = "clock/solution"

[[parts]]
given = ["longest/test_longest.py"]
tests = ["longest/test_longest_hidden.py"]
reference = "longest/solution"
+++
A habit tracker keeps a log, a line for each habit done on a day, and `Tracker` says how
each habit's streak is going. Its streaks are hard to test: `Tracker` reads the log from a
file, and asks the system's clock what day it is, so a test can only ever check today.

Refactor it so a test can give it the log's lines and the day, as the new tests in
`test_tracker_clock.py` do: `Tracker(read=..., today=...)`, where `read()` gives the log's
lines and `today()` gives the date. `Tracker(path)` must still work as it did, as the app uses
it, and the existing tests must still pass.

## Part 2

Add `longest(habit)`, the most days in a row the habit has ever been done, and `records()`,
a line for each habit, in alphabetical order, with its longest streak, as
`reading: best 2 days`.

## Explanation

Separate what talks to the outside world from the logic. Reading the file and asking the clock
become things a `Tracker` is given, `read` and `today`, with defaults that read the file at
`path` and ask the system's clock, so `Tracker(path)` still works. Parsing the log's lines is
its own function, `parse_log`, which needs no file, and counting a streak is a function of the
days and today, which needs no clock. Both are then easy to test on their own.

Ask the clock and read the log each time they're needed, rather than once in `__init__`, as a
tracker kept for a while must see new days and new lines.

For part 2, the longest run is counted from each day that starts one, a day whose day before
isn't in the log, so each day is looked at a few times at most, and the order of the log's
lines doesn't matter. With the logic already apart from the file and the clock, it's a new
function and a method beside `summary`, tested without a file.

## Hints

- Start by moving the parsing out of `read_log` into a function that takes lines.
- A default argument can be a function, such as `today=datetime.date.today`.

## Part 2 hints

- A day starts a run when the day before it isn't in the log.
