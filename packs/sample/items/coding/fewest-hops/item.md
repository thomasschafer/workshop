+++
kind = "coding"
title = "Fewest hops between towns"
skills = ["algorithms.graphs"]
minutes = 20

languages = ["python", "rust"]
reference = ["reference.py", "reference.rs"]
starter = ["starter.py", "starter.rs"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
There are n towns, numbered from 1 to n, and m roads, each joining two towns in both
directions. Print the fewest roads needed to get from town 1 to town n, or -1 if you can't get
there at all.

The input is n and m on the first line, then a line for each road with the two towns it joins.
There's at least one town; a road may join a town to itself, and two towns may have more than
one road between them.

## Approach

Breadth-first search from town 1. It visits towns in order of how many roads away they are, so
the first time it reaches a town is by the fewest roads. Keep each town's distance, start the
queue with town 1 at 0, and give each newly reached neighbour one more than the town it was
reached from. O(n + m) time.

## Hints

- Every road costs the same. Which search reaches nearer towns before farther ones?
- How do you avoid visiting a town twice, and does it matter which way you reached it first?

## Notes

With roads of different lengths, breadth-first search is no longer enough, and Dijkstra's
algorithm does the job instead.
