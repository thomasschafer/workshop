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

## Brief

- Who uses it: other services in the same organisation, such as shopping baskets and user settings, through a client library. No person uses it directly.
- What it must do: get, put and delete a value by its key. No range scans, transactions or secondary indexes.
- Data: keys up to 256 bytes, values usually about 1 KB and at most 1 MB. 10 TB in all today, growing by half each year.
- Load: 200,000 reads and 50,000 writes a second at peak. A few keys, such as widely shared settings, get thousands of reads a second each.
- Latency: reads and writes under 10 ms at the 99th percentile, within a data centre.
- Availability: reads and writes keep working when any one machine fails, and ideally when a whole rack does. One data centre for now.
- Consistency: reads can be up to a second stale by default, but a caller must be able to ask for a read that sees its own latest write. When two writes to a key conflict, the later one wins.
- Durability: a write that's been acknowledged is never lost when one machine's disk fails.
- Out of scope: copies in other data centres, and access control beyond which services may connect.
