+++
kind = "mental-maths"
skills = ["arithmetic.percentages"]
answer = "p * n * 20 / 100"
require = "p * n * 20 % 100 == 0"

[params]
p = { choices = [5, 10, 15, 20, 25, 30, 40, 60, 75] }
n = { min = 4, max = 60 }

[derived]
whole = "n * 20"
+++
What's {p}% of {whole}?

## Method

Find 10% or 5% of {whole} first, and build {p}% from those: {answer}.
