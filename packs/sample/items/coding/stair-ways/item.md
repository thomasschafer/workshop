+++
kind = "coding"
title = "Ways up a broken staircase"
skills = ["algorithms.dynamic-programming"]
difficulty = 2
minutes = 20

languages = ["python", "rust"]
reference = ["reference.py", "reference.rs"]
starter = ["starter.py", "starter.rs"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
A staircase has n steps above the floor, numbered 1 to n. You start on the floor, at step 0,
and climb 1, 2 or 3 steps at a time, but some steps are broken and you can't stand on them.
Print how many different ways there are to reach step n, modulo 1 000 000 007.

The input is n and the number of broken steps, k, on the first line, then the k broken steps,
each between 1 and n − 1, on the second line (which is empty when k is 0). n is between 1 and
10⁵.

## Approach

Let ways[s] be the number of ways to reach step s. ways[0] is 1, a broken step has 0 ways, and
any other step can be reached from the three steps below it, so ways[s] = ways[s − 1] +
ways[s − 2] + ways[s − 3], taking steps below the floor as 0. Fill it in from the bottom,
taking the modulo as you go. O(n) time, and O(1) space if you keep only the last three.

## Hints

- How could you have arrived on step s, in your last move?
- The number of ways to reach a step only depends on the steps just below it. Work upwards.
