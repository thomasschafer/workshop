+++
kind = "reading"
title = "When a map's closure runs"
skills = ["rust.semantics"]
prints = "start 1 2 3 Some(6)"
+++
What does this print?

```rust
fn main() {
    let mut doubled = [1, 2, 3, 4].into_iter().map(|n| {
        print!("{n} ");
        n * 2
    });
    print!("start ");
    let first_big = doubled.find(|&d| d > 4);
    println!("{first_big:?}");
}
```

## Explanation

Iterators are lazy: map only describes the work, and its closure runs as each item is asked
for. Nothing is asked for until find, so "start" comes first. find then takes items one at a
time until one passes, and stops there: 3 doubles to 6, which is more than 4, so 4 is never
doubled at all.
