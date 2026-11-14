+++
kind = "reading"
title = "Adding to a global"
skills = ["python.semantics"]
choices = [
  "Nothing: it prints 1",
  "It prints 0, as increment changes a copy of count",
  "It raises UnboundLocalError: assigning to count makes it local to increment, so it's read before it has a value",
  "It raises a SyntaxError, as += can't be used on a global",
]
answer = 3

[check]
expect = "exception"
+++
What happens when this runs?

```python
count = 0


def increment():
    count += 1


increment()
print(count)
```

## Explanation

Python decides which names are local to a function before it runs: any name assigned
anywhere in the body is local throughout it. `count += 1` assigns to count, so count is local
to increment, and reading it for the addition finds a local with no value yet. Say
`global count` at the top of the function to mean the module's count, or better, pass the
value in and return the new one.
