+++
kind = "reading"
title = "The first even number"
skills = ["haskell.laziness"]
choices = [
  "It prints 3, then 0",
  "It stops with an exception before printing anything, as firstEven is worked out where it's defined",
  "It doesn't compile, as head might be given an empty list",
  "It prints 3, then stops with an exception, as no reading is even and head is given an empty list",
]
answer = 4

[check]
expect = "exception"
+++
What happens when this runs?

```haskell
main :: IO ()
main = do
  let readings = [3, 1, 5] :: [Int]
      firstEven = head (filter even readings)
  print (length readings)
  print firstEven
```

## Explanation

`let` doesn't work anything out: firstEven is only evaluated when something needs its value,
which is the second print. The first print runs first, and shows 3. Then head is given the empty
list that filtering for even readings makes, and stops the program with an exception. The types
are fine, as head takes any list, empty or not; GHC may warn that head is partial, but it builds.
