+++
kind = "probability"
skills = ["probability.conditional"]
answer = "1/3"

[simulation]
trials = 100000
tolerance = 0.006
+++
Two fair coins are tossed, and you're told that at least one is heads. What's the probability that
both are?

## Solution

Of the four equally likely outcomes, three have at least one head (HH, HT, TH), and one of those
is both heads, so it's 1/3.

## Simulation

```rhai
// Toss again until at least one is heads, which is what we're told.
loop {
    let first = rand_bool(0.5);
    let second = rand_bool(0.5);
    if first || second { return first && second; }
}
```
