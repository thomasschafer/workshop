+++
kind = "design"
skills = ["systems.reliability", "systems.networking"]
minutes = 20
+++
Design a rate limiter that lets each client make at most 100 requests a minute to an API served by many machines.

## Rubric

- Chooses an algorithm, such as a token bucket or a sliding window, and says what bursts it allows
- Keeps the counts where every machine can see them, and says how they stay consistent
- Says what a client is told when it's limited
- Says what happens when the store of counts is slow or unavailable
