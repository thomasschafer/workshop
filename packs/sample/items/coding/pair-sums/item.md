+++
kind = "coding"
title = "Pairs with a given sum"
skills = ["algorithms.hashing"]
minutes = 15

languages = ["python", "rust"]
reference = ["reference.py", "reference.rs"]
starter = ["starter.py", "starter.rs"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
Given a list of whole numbers and a target, count the pairs of positions i < j where the
numbers at i and j add up to the target. The same number can appear more than once, and each
pair of positions counts separately.

The input is n and the target on the first line, then the n numbers, separated by spaces. n is
at least 1, and every number, and the target, is between -10⁶ and 10⁶.

## Approach

Go through the numbers in order, keeping a count of how many times each number has been seen
so far. Each number pairs with every earlier copy of target − number, so add that count to the
answer before counting the number itself. One pass with a hash map: O(n) time and space.

## Hints

- For a given number, which other number would it need to pair with?
- If you knew how many times each number had appeared before the current one, how many pairs
  would the current one complete?

## Notes

Counting the number before looking up its partner would pair a number with itself when it's
half the target.
