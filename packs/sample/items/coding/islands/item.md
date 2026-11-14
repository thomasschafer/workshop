+++
kind = "coding"
title = "Count the islands"
skills = ["algorithms.graphs"]
minutes = 20

languages = ["python", "rust"]
reference = ["reference.py", "reference.rs"]
starter = ["starter.py", "starter.rs"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"
+++
A map is a grid of `#` for land and `.` for water. Two land squares are on the same island if
you can walk from one to the other through land, moving up, down, left or right. Print how many
islands there are.

The input is the number of rows and columns on the first line, then the rows of the grid. The
grid has at least one row and one column.

## Approach

Go through every square. When you find land you haven't visited, that's a new island: count it,
then visit all of its land with a breadth-first or depth-first search from there, marking each
square as you reach it. Every square is visited once, so it's O(rows × columns).

## Hints

- This is a question about connected parts of a graph. What are the nodes, and what are the
  edges?
- Once you've found one square of an island, how do you make sure you don't count the rest of
  it again?

## Notes

A recursive depth-first search can run out of stack on a big grid of land; a queue or an
explicit stack can't.
