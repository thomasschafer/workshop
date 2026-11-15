+++
kind = "coding"
title = "The first word to repeat"
skills = ["algorithms.hashing"]
difficulty = 1
minutes = 10

languages = ["python", "rust"]
reference = ["reference.py", "reference.rs"]
starter = ["starter.py", "starter.rs"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
Reading a line of words from left to right, print the first word that you come across for the
second time. If no word appears twice, print `none`.

The input is one line of lowercase words separated by single spaces, with at least one word.

## Approach

Keep a set of the words seen so far. Go through the words in order: the first one already in
the set is the answer. Checking and adding to a hash set takes O(1) on average, so it's O(n)
overall.

## Hints

- What do you need to remember about the words you've already read?
- The answer is decided by where the second copy is, not the first.
