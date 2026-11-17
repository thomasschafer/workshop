+++
kind = "reading"
title = "Odd multiples of three"
skills = ["haskell.laziness"]
prints = "[3,9,15,21,27]"
+++
What does this print?

```haskell
main :: IO ()
main = print (take 5 (filter odd (map (* 3) [1 ..])))
```

## Explanation

`[1 ..]` never ends, but nothing in it is made until it's needed. take asks for five items,
filter asks map for items until it has five odd ones, and map makes each from the next number.
The multiples of three are 3, 6, 9, 12 and so on, and every other one is odd, so the first five
odd ones are 3, 9, 15, 21 and 27, and nothing after the ninth number is ever made.
