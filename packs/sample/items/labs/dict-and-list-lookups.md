+++
kind = "lab"
title = "Timing lookups in a list and a dict"
skills = ["algorithms.complexity"]
minutes = 20

[[sources]]
title = "timeit: measure execution time of small code snippets"
url = "https://docs.python.org/3/library/timeit.html"

[[sources]]
title = "Python wiki: time complexity"
url = "https://wiki.python.org/moin/TimeComplexity"
+++
Time how long Python takes to find a value in a list and in a dict as each grows, and see which slows down with its size.

## Setup

Any computer with Python 3.8 or later, and a terminal. The commands use `python3`; on Windows, type `python` instead. Each one uses Python's `timeit` module, which runs a statement many times and prints how long one run took, such as `200 nsec per loop`. Your times will differ from anyone else's, so record what you see, units and all.

## Time a lookup in a list and a dict

Make a list of a thousand numbers and a dict with the same keys, then time finding the last of them in each:

```sh
python3 -m timeit -s "xs = list(range(1_000)); d = dict.fromkeys(xs)" "999 in xs"
python3 -m timeit -s "xs = list(range(1_000)); d = dict.fromkeys(xs)" "999 in d"
```

Record the time per loop that each prints.

### Expected

Both are quick, but the list is far slower: typically a few microseconds against a few tens of nanoseconds for the dict, a hundred times or more. `in` on a list compares the value with each item in turn until one matches, and 999 is the last, so it makes a thousand comparisons. The dict hashes 999 to find the one slot it could be in. The numbers depend on the machine; the gap between them is what matters.

## Grow them tenfold, and again

Run both commands again with ten thousand items, looking up 9,999, and then with a hundred thousand, looking up 99,999:

```sh
python3 -m timeit -s "xs = list(range(10_000)); d = dict.fromkeys(xs)" "9_999 in xs"
python3 -m timeit -s "xs = list(range(10_000)); d = dict.fromkeys(xs)" "9_999 in d"
python3 -m timeit -s "xs = list(range(100_000)); d = dict.fromkeys(xs)" "99_999 in xs"
python3 -m timeit -s "xs = list(range(100_000)); d = dict.fromkeys(xs)" "99_999 in d"
```

Record the four times.

### Expected

The list's time grows about tenfold each time, as it makes ten times as many comparisons: a lookup in a list is O(n). The dict's stays about the same, within noise, whatever its size: a lookup in a dict is O(1) on average, as hashing finds the slot without looking at the other keys. By a hundred thousand items, the list is thousands of times slower.

## Look up a value that isn't there

With a hundred thousand items, time looking up 100,000, which neither holds, as `range` stops just before it:

```sh
python3 -m timeit -s "xs = list(range(100_000)); d = dict.fromkeys(xs)" "100_000 in xs"
python3 -m timeit -s "xs = list(range(100_000)); d = dict.fromkeys(xs)" "100_000 in d"
```

Record both times, beside your times for 99,999 from the last step.

### Expected

The list takes about as long as it did for 99,999, as it has to compare 100,000 with every item before it can say it isn't there. The dict is still quick: a miss hashes 100,000 to a slot and finds it empty, costing about what a hit does.

## Explain

Why does `in` on the list slow down as it grows while `in` on the dict doesn't, and when might a list still be the better choice?

## Explain answer

A list keeps its items in order and has no index by value, so `in` compares with each item until it finds a match, or reaches the end for a value that isn't there: O(n), growing with the list. A dict hashes the key to find the slot it would be in, and only compares with what's there, so a lookup costs about the same at any size: O(1) on average. A list can still be better when it's small, when lookups are rare, when order or duplicates matter, or when building a dict, which takes O(n) time and more memory, would cost more than the lookups it saves.
