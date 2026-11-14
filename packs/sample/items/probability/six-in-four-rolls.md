+++
kind = "probability"
skills = ["probability.complements"]
answer = "671/1296"

[simulation]
trials = 100000
tolerance = 0.006
+++
A fair die is rolled four times. What's the probability of at least one six?

## Solution

The chance of no six in four rolls is (5/6)⁴ = 625/1296, so at least one six has probability
1 − 625/1296 = 671/1296, about 0.518.

## Simulation

```rhai
let six = false;
for roll in 0..4 {
    if rand_int(1, 6) == 6 { six = true; }
}
six
```
