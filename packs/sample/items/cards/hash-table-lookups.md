+++
kind = "card"
skills = ["data-structures", "algorithms.complexity"]
+++
A hash table looks up a key in constant time on average. When does a lookup take time
proportional to the number of keys?

## Answer

When many keys hash to the same bucket, such as with a poor hash function, or keys chosen to
collide.

## Explanation

The average case relies on keys spreading evenly over the buckets, with the table resized to keep
the load factor bounded. If they all collide, a lookup searches one long chain.
