+++
kind = "mental-maths"
skills = ["estimation.arithmetic"]
track = "estimation"
answer = "x * y"
relative_tolerance = 0.1

[params]
a = { min = 213, max = 987 }
b = { min = 1210, max = 8890 }

[derived]
x = "a / 10.0"
y = "b / 100.0"
xr = "sig(a / 10.0, 1)"
yr = "sig(b / 100.0, 1)"
rough = "sig(a / 10.0, 1) * sig(b / 100.0, 1)"
x2 = "sig(a / 10.0, 2)"
y2 = "sig(b / 100.0, 2)"
better = "sig(sig(a / 10.0, 2) * sig(b / 100.0, 2), 2)"
+++
Roughly what's {x} × {y}?

## Method

Round each to one figure first, for the size: {xr} × {yr} = {rough}. That's close enough when one
rounded up and the other down, as the errors cancel. When both went the same way, they add up, so
keep two figures: {x2} × {y2} ≈ {better}.
