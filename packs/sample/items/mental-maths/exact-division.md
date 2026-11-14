+++
kind = "mental-maths"
skills = ["arithmetic.division"]
answer = "b"
require = "a != 10"

[params]
a = { min = 6, max = 19 }
b = { min = 23, max = 99 }

[derived]
product = "a * b"
+++
What's {product} ÷ {a}?

## Method

Find the multiple of {a} nearest {product}, then count on: {a} × {answer} = {product}.
