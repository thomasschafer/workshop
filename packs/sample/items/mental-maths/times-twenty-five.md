+++
kind = "mental-maths"
skills = ["arithmetic.multiplication"]
answer = "a * 25"
require = "a % 4 != 0"

[params]
a = { min = 26, max = 798 }

[derived]
hundred = "a * 100"
+++
What's {a} × 25?

## Method

25 is 100 ÷ 4, so multiply by 100 and halve twice: {hundred} ÷ 4 = {answer}.
