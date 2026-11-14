+++
kind = "probability"
skills = ["probability.counting", "probability.conditional"]
answer = "1/221"

[simulation]
trials = 200000
tolerance = 0.0006
+++
Two cards are drawn from a shuffled 52-card deck without putting the first back. What's the
probability that both are aces?

## Solution

The first is an ace with probability 4/52, and then the second with probability 3/51, giving
(4/52)(3/51) = 12/2652 = 1/221.

## Simulation

```rhai
// Cards 1 to 4 are the aces.
if rand_int(1, 52) > 4 { return false; }
// One ace is gone, leaving 51 cards, 3 of them aces.
rand_int(1, 51) <= 3
```
