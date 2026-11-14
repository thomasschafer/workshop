+++
kind = "mental-maths"
skills = ["arithmetic.multiplication"]
answer = "a * b"
require = "a % 10 != 0 && b % 10 != 0 && a != 11 && b != 11"

[params]
a = { min = 13, max = 99 }
b = { min = 13, max = 99 }

[derived]
tens = "b / 10 * 10"
units = "b % 10"
first = "a * (b / 10 * 10)"
second = "a * (b % 10)"
+++
What's {a} × {b}?

## Method

Split {b} into {tens} and {units}: {a} × {tens} = {first}, and {a} × {units} = {second}. Their
sum is {answer}.
