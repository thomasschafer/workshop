+++
kind = "mental-maths"
skills = ["estimation.arithmetic"]
track = "estimation"
answer = "x / y"
relative_tolerance = 0.1

[params]
a = { min = 10000, max = 99999 }
b = { min = 110, max = 990 }

[derived]
x = "a / 10.0"
y = "b / 10.0"
yr = "sig(b / 10.0, 1)"
rough = "sig(a / 10.0 / sig(b / 10.0, 1), 2)"
change = "round(abs(sig(b / 10.0, 1) - b / 10.0) / (b / 10.0) * 100.0)"
+++
Roughly what's {x} ÷ {y}?

## Method

Divide by an easy number near {y}, such as {yr}: {x} ÷ {yr} ≈ {rough}. Moving the divisor by
{change}% moves the answer by about as much the other way, so if you rounded {y} up, nudge
{rough} up, and if down, nudge it down.
