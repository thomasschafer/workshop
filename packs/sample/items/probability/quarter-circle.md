+++
kind = "probability"
skills = ["probability.geometric"]
answer = "0.785398"

[simulation]
trials = 100000
tolerance = 0.006
+++
A point is chosen uniformly at random in the unit square. What's the probability that it's within
distance 1 of the corner at (0, 0)?

## Solution

The points within distance 1 of the corner form a quarter of a circle of radius 1, of area π/4,
and the square's area is 1, so it's π/4, about 0.785.

## Simulation

```rhai
let x = rand_float();
let y = rand_float();
x * x + y * y <= 1.0
```
