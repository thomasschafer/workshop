+++
kind = "card"
skills = ["systems.reliability"]
+++
What makes an operation idempotent, and why does it matter when a request is retried?

## Answer

Doing it twice has the same effect as doing it once, so a retry after a lost reply can't apply it
twice.

## Explanation

A client that hears nothing back can't tell whether the request arrived. With an idempotent
operation, such as setting a value, or one carrying a unique key the server remembers, it can
safely send it again.
