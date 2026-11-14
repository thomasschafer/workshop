+++
kind = "mental-maths"
skills = ["arithmetic.multiplication"]
answer = "a * a"

[params]
a = { min = 11, max = 59 }

[derived]
gap = "abs((a + 5) / 10 * 10 - a)"
low = "a - abs((a + 5) / 10 * 10 - a)"
high = "a + abs((a + 5) / 10 * 10 - a)"
+++
What's {a}²?

## Method

Round to a multiple of ten and back: {a}² = {low} × {high} + {gap}², which is {answer}.
