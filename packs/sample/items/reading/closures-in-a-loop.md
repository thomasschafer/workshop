+++
kind = "reading"
title = "Functions made in a loop"
skills = ["python.semantics"]
prints = "[20, 20, 20]"
+++
What does this print?

```python
scalers = [lambda x: x * i for i in range(3)]
print([scale(10) for scale in scalers])
```

## Explanation

Each lambda refers to the variable i, not to the value i had when the lambda was made, and it
looks i up only when it's called. By then the loop has finished, leaving i at 2, so all three
multiply by 2. To keep each value, bind it as a default argument, `lambda x, i=i: x * i`, or
use functools.partial.
