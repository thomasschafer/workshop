+++
kind = "probability"
skills = ["probability.complements", "probability.counting"]
answer = "0.0271356"

[simulation]
trials = 100000
tolerance = 0.002
+++
Five people's birthdays are each equally likely to be any of 365 days. What's the probability that
at least two of them share a birthday?

## Solution

All five differ with probability (364/365)(363/365)(362/365)(361/365), about 0.9729, so at least
two share with probability about 0.0271.

## Simulation

```rhai
let days = [];
let repeated = false;
for person in 0..5 {
    let day = rand_int(1, 365);
    if days.contains(day) { repeated = true; }
    days.push(day);
}
repeated
```
