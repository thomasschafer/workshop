+++
kind = "coding"
title = "Keeping count of stock"
skills = ["algorithms.hashing", "data-structures"]
difficulty = 1
minutes = 15

languages = ["python"]
reference = ["reference.py"]
starter = ["starter.py"]
brute_force = "brute.py"
inputs = "inputs.py"
tests = "tests.toml"

[api]
class = "Stock"

[[parts]]
reference = ["sell-what-there-is/reference.py"]
brute_force = "sell-what-there-is/brute.py"
inputs = "sell-what-there-is/inputs.py"
tests = "sell-what-there-is/tests.toml"
# Selling changes, so part 1's tests of it no longer apply.
replaces = [1]
+++
Write a `Stock` class that keeps count of what a shop has in stock. It starts with nothing,
and has three methods:

- `add(item, count)`: `count` more of `item` arrive. It returns nothing.
- `sell(item, count)`: sells `count` of `item`, if there are that many, and returns `True`.
  With fewer in stock, it sells none, and returns `False`.
- `count(item)` returns how many of `item` are in stock: 0 for one that's never arrived.

Items are names, such as `"pens"`, and every count is at least 1.

## Part 2

Selling what there is beats selling nothing. Change `sell` to sell as many as it can, up to
`count`, and return how many it sold, rather than `True` or `False`.

Also add `low(limit)`, which returns the items that have ever arrived and now have fewer than
`limit` in stock, sold-out ones included, in alphabetical order.

## Approach

Keep a dictionary from each item to how many are in stock, so adding, selling and counting each
take O(1) on average. An item that sells out stays in it, at 0, as it has still arrived.

`low` looks at every item, so it takes O(k log k) for k items, sorting the low ones. That's
fine as it's asked for now and then; asked for constantly, the items could be kept in order by
count instead.

## Hints

- What should counting an item that never arrived give, without a special case everywhere?

## Part 2 hints

- `min` gives how many can be sold.
- An item sold out has still arrived, so `low` includes it.
