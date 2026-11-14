+++
kind = "mental-maths"
skills = ["arithmetic.addition"]
answer = "1000 - a"
require = "a % 10 != 0"

[params]
a = { min = 101, max = 999 }
+++
What's 1000 − {a}?

## Method

Take each digit of {a} from 9, and the last from 10: {answer}.
