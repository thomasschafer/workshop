+++
kind = "probability"
skills = ["probability.expectation"]
answer = "14.7"

[simulation]
trials = 100000
tolerance = 0.08
+++
A fair die is rolled until every face has come up at least once. How many rolls does that take on
average?

## Solution

With k faces still to see, each roll shows a new one with probability k/6, taking 6/k rolls on
average. Adding those up, 6/6 + 6/5 + 6/4 + 6/3 + 6/2 + 6/1 = 14.7.

## Simulation

```rhai
let seen = [false, false, false, false, false, false];
let left = 6;
let rolls = 0;
while left > 0 {
    let face = rand_int(0, 5);
    rolls += 1;
    if !seen[face] { seen[face] = true; left -= 1; }
}
rolls
```
