+++
kind = "mental-maths"
skills = ["arithmetic.percentages"]
answer = "p * n * 20 / 100"
require = "p * n * 20 % 100 == 0"

[params]
p = { choices = [12, 15, 18, 24, 35, 45, 65, 72, 85] }
n = { min = 11, max = 99 }

[derived]
whole = "n * 20"
+++
What's {p}% of {whole}?

## Method

Find 10%, 5% and 1% of {whole} first, and build {p}% from those, adding or taking away: {answer}.
