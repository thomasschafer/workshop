+++
kind = "coding"
title = "Longest rising run"
skills = ["algorithms.arrays"]
difficulty = 2
minutes = 15

languages = ["python", "rust"]
reference = ["reference.py", "reference.rs"]
starter = ["starter.py", "starter.rs"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
A sensor logs a list of readings. Print the length of the longest stretch of consecutive
readings in which each reading is strictly greater than the one before it. A single reading
on its own is a stretch of length 1.

The input is the number of readings, n, on the first line, then the n readings, separated by
spaces. There's at least one reading, and each is between -1000 and 1000.

## Approach

Walk the readings once, keeping the length of the rise that ends at the current reading: one
more than before if it's bigger than the previous reading, and otherwise back to 1. The answer
is the longest that ever gets. One pass, O(n) time and O(1) extra space.

## Hints

- What do you need to know about the readings before the current one to extend a rise?
- A rise ending here is either one longer than the rise ending at the previous reading, or a
  new rise of length 1.

## Notes

Comparing every start with every end works too, but takes O(n²) time.
