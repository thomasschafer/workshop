+++
kind = "mental-maths"
skills = ["estimation.growth"]
track = "estimation"
answer = "(1.0 + r / 100.0) ** n"
relative_tolerance = 0.1
require = "r * n >= 40 && r * n <= 300"

[params]
r = { min = 2, max = 15 }
n = { min = 5, max = 40 }

[derived]
years = "sig(72.0 / r, 2)"
doublings = "sig(n * r / 72.0, 2)"
rough = "sig(2.0 ** (n * r / 72.0), 2)"
+++
Something grows by {r}% a year. Roughly how many times bigger is it after {n} years?

## Method

Use the rule of 72: at {r}% a year it doubles about every 72 ÷ {r} ≈ {years} years. So {n} years
is about {doublings} doublings, and 2 to that power is about {rough}.
