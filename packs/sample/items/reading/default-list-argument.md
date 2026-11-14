+++
kind = "reading"
title = "A list as a default argument"
skills = ["python.semantics"]
prints = "['red', 'blue'] ['red', 'blue']"
+++
What does this print?

```python
def add_tag(tag, tags=[]):
    tags.append(tag)
    return tags


first = add_tag("red")
second = add_tag("blue")
print(first, second)
```

## Explanation

A default value is made once, when the def runs, not on each call. Both calls leave out tags,
so both append to that same list, and first and second are the one list. To start afresh each
call, default to None and make the list in the body: `if tags is None: tags = []`.
