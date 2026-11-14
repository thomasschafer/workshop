+++
kind = "card"
skills = ["algorithms.complexity"]
+++
How many times does the inner line run, in terms of n?

```python
for i in range(n):
    for j in range(i):
        count += 1
```

## Answer

n(n − 1)/2 times, which is O(n²).

## Explanation

The inner loop runs 0, 1, 2, … n − 1 times, and those add up to n(n − 1)/2.
