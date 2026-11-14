+++
kind = "probability"
skills = ["probability.counting"]
answer = "1/6"

[simulation]
trials = 100000
tolerance = 0.005
+++
Two fair dice are rolled. What's the probability that they add up to 7?

## Solution

Of the 36 equally likely pairs, six add up to 7: (1, 6), (2, 5) and so on to (6, 1). That's
6/36 = 1/6.

## Simulation

```rhai
rand_int(1, 6) + rand_int(1, 6) == 7
```
