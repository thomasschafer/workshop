+++
kind = "coding"
title = "Lowest balance"
skills = ["algorithms.arrays"]
difficulty = 1
minutes = 10

languages = ["haskell", "python"]
reference = ["reference.hs", "reference.py"]
starter = ["starter.hs", "starter.py"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
An account starts at 0, and each day's change is added to it in turn. Print the lowest the
balance ever is, counting the 0 it starts at, so a balance that never goes below 0 has 0 as its
lowest.

The input is the number of days, n, on the first line, then the n changes, separated by
spaces. There's at least one day, and each change is between -1000 and 1000.

## Approach

Keep a running total of the changes, and the smallest it's been, starting both at 0. In
Haskell, `scanl (+) 0 changes` is every balance in turn, the 0 included, and `minimum` of that
is the answer. One pass, O(n) time; the list of balances is made as `minimum` uses it, so it's
O(1) extra space too.

## Hints

- What's the balance after each day, in terms of the balance the day before?
- The lowest balance is the smallest of all of them, including the one before the first day.

## Notes

Adding up each day's changes from the start again takes O(n²) time. `scanl` is to `foldl` what
a list of every running total is to the final one.
