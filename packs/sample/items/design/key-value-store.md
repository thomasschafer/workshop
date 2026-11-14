+++
kind = "design"
skills = ["systems.reliability", "systems.scaling"]
minutes = 35
+++
Design a key-value store spread across many machines, which keeps answering reads and writes when one of the machines fails.

## Rubric

- Says how keys are split between machines, and how they move when machines are added or removed
- Keeps copies of each key on more than one machine, and says how many must answer a read or a write
- Chooses what a read sees after a write, and what that costs when machines disagree
- Says how a failed machine is noticed, and how its copies are rebuilt when it comes back or is replaced
- Considers keys that are far busier than the rest

## Notes

A good answer ties the number of copies, and how many must answer, to what the store promises: more copies answering means stronger reads at the cost of latency and availability.
