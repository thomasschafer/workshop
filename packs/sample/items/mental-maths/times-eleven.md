+++
kind = "mental-maths"
skills = ["arithmetic.multiplication"]
answer = "a * 11"

[params]
a = { min = 112, max = 989 }
+++
What's {a} × 11?

## Method

Add {a} × 10 and {a}: {answer}. Digit by digit, that's the first and last digits of {a}, with
the sums of neighbouring digits between them, carrying from the right when one is 10 or more.
