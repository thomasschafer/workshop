+++
kind = "probability"
skills = ["probability.conditional"]
answer = "2/13"

[simulation]
trials = 100000
tolerance = 0.006
+++
One in a hundred people has a condition. A test finds it 90% of the time in people who have it,
and wrongly finds it 5% of the time in people who don't. Someone tests positive. What's the
probability that they have the condition?

## Solution

Of 1000 people, 10 have it and 9 of them test positive; of the 990 who don't, 49.5 test positive
on average. So it's 9 / (9 + 49.5) = 2/13, about 0.154.

## Simulation

```rhai
// Test people until someone tests positive, which is who we're asked about.
loop {
    let has_it = rand_bool(0.01);
    let positive = if has_it { rand_bool(0.9) } else { rand_bool(0.05) };
    if positive { return has_it; }
}
```
