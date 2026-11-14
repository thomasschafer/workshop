+++
kind = "probability"
skills = ["probability.counting", "probability.complements"]
answer = "3/8"

[simulation]
trials = 100000
tolerance = 0.006
+++
Four letters are put into their four addressed envelopes at random, one in each. What's the
probability that no letter is in its own envelope?

## Solution

Of the 24 orders, 9 leave no letter in place (the derangements of four), so it's 9/24 = 3/8.
By inclusion–exclusion, that's 1 − 1 + 1/2 − 1/6 + 1/24.

## Simulation

```rhai
let order = shuffle([0, 1, 2, 3]);
let none_in_place = true;
for i in 0..4 {
    if order[i] == i { none_in_place = false; }
}
none_in_place
```
