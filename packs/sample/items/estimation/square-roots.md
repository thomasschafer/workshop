+++
kind = "mental-maths"
skills = ["estimation.arithmetic"]
track = "estimation"
answer = "sqrt(n * 1.0)"
relative_tolerance = 0.02
require = "floor(sqrt(n * 1.0)) * floor(sqrt(n * 1.0)) != n * 1.0"

[params]
n = { min = 150, max = 9800 }

[derived]
s = "floor(sqrt(n * 1.0))"
square = "floor(sqrt(n * 1.0)) * floor(sqrt(n * 1.0))"
twice = "2.0 * floor(sqrt(n * 1.0))"
rough = "sig(floor(sqrt(n * 1.0)) + (n - floor(sqrt(n * 1.0)) * floor(sqrt(n * 1.0))) / (2.0 * floor(sqrt(n * 1.0))), 3)"
+++
Roughly what's √{n}?

## Method

Find the square just below: {s}² = {square}. Then go up by the gap divided by twice that root:
{s} + ({n} − {square}) ÷ {twice} ≈ {rough}. That's a touch high, as the true gap between squares
grows, but it's well within 2%.
