+++
kind = "reading"
title = "Adding up small numbers"
skills = ["rust.semantics"]
choices = [
  "It prints 300",
  "It prints 44, wrapping around past 255",
  "It panics, as the sum overflows a u8",
  "It doesn't compile, as the compiler sees the overflow coming",
]
answer = 3

[check]
expect = "panic"
+++
What happens when this runs, in a debug build?

```rust
fn main() {
    let sizes: Vec<u8> = vec![200, 100];
    let total: u8 = sizes.iter().sum();
    println!("{total}");
}
```

## Explanation

A u8 holds 0 to 255, and 200 + 100 doesn't fit. A debug build checks arithmetic for overflow
and panics with "attempt to add with overflow". A release build doesn't check, and wraps
around to 44, so the same code gives a different answer once it's optimised. Sum into a wider
type, such as `sizes.iter().map(|&s| u32::from(s)).sum::<u32>()`, or say what should happen
with checked_add, wrapping_add or saturating_add.
