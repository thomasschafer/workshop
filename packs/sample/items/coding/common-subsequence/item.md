+++
kind = "coding"
title = "Longest common subsequence"
skills = ["algorithms.dynamic-programming"]
minutes = 25

languages = ["python", "rust"]
reference = ["reference.py", "reference.rs"]
starter = ["starter.py", "starter.rs"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
A subsequence of a word is what's left after crossing out any number of its letters, keeping
the rest in order: `ace` is a subsequence of `abcde`. Given two words, print the length of the
longest word that's a subsequence of both.

The input is the two words, of lowercase letters, one on each line. Each has between 1 and
2000 letters.

## Approach

Let best[i][j] be the answer for the first i letters of one word and the first j of the other.
If their last letters match, best[i][j] = best[i − 1][j − 1] + 1; otherwise it's the larger of
best[i − 1][j] and best[i][j − 1], leaving out one or the other's last letter. Fill the table
row by row: O(len₁ × len₂) time, and two rows of space are enough.

## Hints

- Think about the last letter of each word. Either they're part of the common subsequence
  together, or at least one of them isn't in it at all.
- That gives an answer for two prefixes in terms of shorter prefixes. What table does it fill?
