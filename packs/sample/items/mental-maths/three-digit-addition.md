+++
kind = "mental-maths"
skills = ["arithmetic.addition"]
answer = "a + b"
# Carrying from the units and the tens, so it takes some keeping track of.
require = "a % 10 + b % 10 >= 10 && a / 10 % 10 + b / 10 % 10 >= 9"

[params]
a = { min = 156, max = 989 }
b = { min = 156, max = 989 }
+++
What's {a} + {b}?

## Method

Add the hundreds, then the tens, then the units, left to right: {answer}.
