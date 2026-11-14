+++
kind = "mental-maths"
skills = ["estimation.magnitudes"]
track = "estimation"
answer = "(2 ** k) / 1000000000.0"
relative_tolerance = 0.05

[params]
k = { min = 31, max = 49 }

[derived]
q = "k / 10"
r = "k % 10"
small = "2 ** (k % 10)"
rough = "(2 ** (k % 10)) * (10 ** (3 * (k / 10) - 9))"
nudge = "round((1.024 ** (k / 10) - 1.0) * 100.0)"
+++
Roughly how many billions is 2 to the power {k}?

## Method

2¹⁰ is 1,024, about a thousand. So 2^{k} = 2^{r} × (2¹⁰)^{q} ≈ {small} × 1000^{q}, which is
{rough} billion. Each 2¹⁰ is 2.4% more than a thousand, so with {q} of them, add about {nudge}%.
