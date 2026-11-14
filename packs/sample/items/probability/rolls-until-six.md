+++
kind = "probability"
skills = ["probability.expectation"]
answer = "6"

[simulation]
trials = 100000
tolerance = 0.07
+++
A fair die is rolled until it shows a six. How many rolls does that take on average?

## Solution

Each roll is a six with probability 1/6, so the number of rolls is geometric, with mean
1 / (1/6) = 6.

## Simulation

```rhai
let rolls = 1;
while rand_int(1, 6) != 6 { rolls += 1; }
rolls
```
