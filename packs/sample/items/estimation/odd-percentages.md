+++
kind = "mental-maths"
skills = ["estimation.arithmetic"]
track = "estimation"
answer = "p * n / 100.0"
relative_tolerance = 0.05
require = "c % 10 != 0"

[params]
c = { min = 113, max = 487 }
n = { min = 1100, max = 98999 }

[derived]
p = "c / 10.0"
whole = "round(c / 10.0)"
ten = "sig(n / 10.0, 3)"
one = "sig(n / 100.0, 3)"
rough = "sig(round(c / 10.0) * n / 100.0, 3)"
+++
Roughly what's {p}% of {n}?

## Method

Round {p}% to {whole}%, and build it from easy parts: 10% of {n} is about {ten}, 1% is about
{one}, and 5% is half of 10%. Adding the parts for {whole}% gives about {rough}. Rounding the
percentage costs less than half a point in {whole}, under 5% of the answer.
