+++
kind = "reading"
title = "Holding a reference while a vector grows"
skills = ["rust.ownership"]
choices = [
  "Nothing: it prints 3",
  "It prints whatever is left in freed memory, as the vector may have moved",
  "It doesn't compile: first borrows scores, so scores can't be changed while first is still used",
  "It panics when push needs more room",
]
answer = 3

[check]
expect = "compile-error"
+++
What's wrong with this code?

```rust
fn main() {
    let mut scores = vec![3, 1, 2];
    let first = &scores[0];
    scores.push(4);
    println!("{first}");
}
```

## Explanation

push may move the elements to a bigger block of memory, which would leave first pointing at
memory that's been freed, as the same code does in C++. Rust's borrow checker rules it out
before the code runs: while a shared borrow such as first is still to be used, scores can't
be borrowed mutably, which push needs. Copy the value out, `let first = scores[0];`, or
keep an index instead.
