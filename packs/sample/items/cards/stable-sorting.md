+++
kind = "card"
skills = ["algorithms.complexity"]
+++
What does it mean for a sorting algorithm to be stable?

## Answer

Items with equal keys stay in the order they were in before sorting.

## Explanation

It matters when sorting by one key after another: sort by name, then stably by city, and each
city's people stay in name order. Merge sort is stable; a typical quicksort isn't.
