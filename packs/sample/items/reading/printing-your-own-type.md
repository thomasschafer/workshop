+++
kind = "reading"
title = "Printing a type of your own"
skills = ["haskell.types"]
choices = [
  "Nothing: it prints Red",
  "It prints 0, the position of Red in the type",
  "It doesn't compile: print needs a Show instance for Colour, and Colour has none",
  "It compiles, then stops with an exception, as Red can't be shown",
]
answer = 3

[check]
expect = "compile-error"
+++
What happens when this is built and run?

```haskell
data Colour = Red | Green | Blue

main :: IO ()
main = print Red
```

## Explanation

`print` has the type `Show a => a -> IO ()`, so whatever it prints needs a Show instance, and a
type you define has none until you give it one. GHC finds that out as it checks the types, so
the program never builds: "No instance for (Show Colour)". Add `deriving (Show)` to the
declaration, and it prints `Red`.
