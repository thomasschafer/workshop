+++
kind = "mental-maths"
skills = ["arithmetic.multiplication"]
answer = "a * b"
require = "a % 10 != 0"

[params]
a = { min = 12, max = 99 }
b = { min = 3, max = 9 }

[derived]
tens = "a / 10 * 10"
units = "a % 10"
+++
What's {a} × {b}?

## Method

Split {a} into {tens} and {units}: {tens} × {b} plus {units} × {b} is {answer}.
