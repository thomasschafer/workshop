+++
kind = "card"
skills = ["data-structures", "algorithms.complexity"]
+++
Appending to a dynamic array sometimes copies every item into a bigger block. Why is appending
still O(1) amortised?

## Answer

Because the capacity doubles each time, so the copying over n appends adds up to less than 2n.

## Explanation

The copies are of 1, 2, 4, … up to n items, a total of under 2n, shared out over n appends. Growing
by a fixed amount instead would make appends O(n) amortised.
