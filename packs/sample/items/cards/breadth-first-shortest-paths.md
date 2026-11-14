+++
kind = "card"
skills = ["algorithms.graphs"]
+++
Why does breadth-first search find shortest paths in a graph whose edges have no weights?

## Answer

It visits nodes in order of their distance from the start, so the first time it reaches a node
is along a path with the fewest edges.

## Explanation

The queue holds every node at distance d before any at distance d + 1. With weighted edges the
fewest edges needn't be the cheapest path, which is what Dijkstra's algorithm is for.
