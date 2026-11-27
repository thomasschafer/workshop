+++
kind = "lesson"
title = "How a binary heap works"
skills = ["data-structures", "algorithms.complexity"]
minutes = 4

[[sources]]
title = "Python's heapq module documentation"
url = "https://docs.python.org/3/library/heapq.html"

[[guesses]]
prompt = "A min-heap is stored in an array with the smallest item at index 0. Where can the second-smallest item be?"
choices = [
  "Always at index 1",
  "At index 1 or index 2",
  "Anywhere in the array",
]
answer = 2

[[guesses]]
prompt = "Building a min-heap bottom-up from n unsorted numbers takes how much time?"
choices = ["O(n)", "O(n log n)", "O(n²)"]
answer = 1

[[checks]]
segment = 1
prompt = "In a 0-indexed binary heap, a node sits at index 3. Where are its children?"
choices = ["Indices 4 and 5", "Indices 6 and 7", "Indices 7 and 8"]
answer = 3
explanation = "A node at index i has children at 2i + 1 and 2i + 2, so index 3 has children at 7 and 8."

[[checks]]
segment = 2
prompt = "When removing the smallest item and sifting down from the root, why swap with the smaller child rather than the larger?"
choices = [
  "Swapping with the larger child would place it above the smaller child, breaking the heap property",
  "The larger child is always a leaf",
  "To keep the backing array sorted from left to right",
]
answer = 1
explanation = "The parent must be no larger than either child, so only the smaller of the two children can safely move above the other."
+++
How a binary min-heap keeps the smallest item at the front in a flat array, and why adding and removing stay O(log n).

## The heap property and array layout

A binary min-heap is a complete binary tree where every parent is less than or equal to both of its children. The smallest item is always at the root, so peeking at it takes O(1) time. Beyond that, siblings aren't ordered against each other: the second-smallest item is one of the root's two children, at index 1 or 2, not necessarily index 1.

Because every level is filled left to right with no gaps, the tree fits in a flat array with no pointers. For a node at index `i`:

- its left child is at `2i + 1`
- its right child is at `2i + 2`
- its parent is at `(i - 1) // 2`

![A binary min-heap drawn as a tree above its backing array, highlighting index 1 and its children at indices 3 and 4](heap-array.svg)

## Adding and removing

Both updates change one end of the array and then walk a single path between a leaf and the root.

To **add** an item, append it to the end of the array so the tree stays complete, then sift up: while it is smaller than its parent, swap them.

To **remove the smallest**, take the root at index 0, move the last item in the array into index 0, and sift down: while it is larger than either child, swap it with the smaller child.

A complete binary tree of `n` items has height `⌊log₂ n⌋`, so both sifts do at most O(log n) swaps.

## Building a heap in O(n)

Adding `n` items one by one sifts each item up from the bottom, where half the nodes live, taking O(n log n) in the worst case.

Building a heap bottom-up reverses the work: start at the last parent and sift each node down. Half the nodes are leaves and do no work at all. A quarter sit one step above the leaves, an eighth two steps above, and so on. Summing `0·(n/2) + 1·(n/4) + 2·(n/8) + 3·(n/16) + …` adds up to less than `n` swaps in total, so building a heap takes O(n) time.

## Explain

Why can a binary heap live in a plain array with no pointers, and why does the same shape guarantee O(log n) updates?

## Explain answer

A binary heap is a complete binary tree filled level by level from left to right, so there are no gaps and every node's parent and children are fixed by simple index arithmetic (`2i + 1`, `2i + 2` and `(i - 1) // 2`), removing the need for pointers. Being complete also keeps the tree balanced with height `⌊log₂ n⌋`, so sifting up after an append or sifting down after replacing the root visits at most one path from root to leaf, taking O(log n) time.
