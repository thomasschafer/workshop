+++
kind = "card"
skills = ["systems.reliability"]
+++
How does a write-back cache differ from a write-through cache, and what's the risk?

## Answer

A write-back cache writes changes to the store later, rather than straight away, so changes not
yet written are lost if the cache fails.

## Explanation

Write-through keeps the store up to date on every write, at the cost of waiting for it. Write-back
answers writes faster and can merge repeated writes, but holds the only copy of recent changes for
a while.
