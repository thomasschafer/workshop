+++
kind = "card"
skills = ["data-structures"]
+++
In a binary heap of n items, what do adding an item, removing the smallest, and looking at the
smallest each cost?

## Answer

Adding and removing take O(log n); looking at the smallest takes O(1).

## Explanation

The smallest is always at the root. Adding or removing moves one item up or down a path from the
root to a leaf, which is about log₂ n long.
