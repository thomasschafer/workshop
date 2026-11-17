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

## Brief

- Who uses it: about 50,000 clients of a public API, each with its own API key. The limit is per key, and the same for every key for now.
- What it must do: decide, for each request, whether its key is under the limit, and refuse it if not. Bursts of up to 20 requests at once are fine, as long as a minute's total stays at 100 or under.
- Scale: 40 API machines behind a load balancer that spreads requests without regard to their key, and 30,000 requests a second at peak in all.
- Latency: checking the limit adds under 2 ms to a request at the 99th percentile.
- Accuracy: letting a client a few percent over its limit now and then is acceptable. Refusing a client that's under its limit is worse.
- Availability: if the limiter can't decide, the request goes through: the API staying up matters more than the limit.
- Responses: a refused client is told it was limited, and when it can try again.
- Out of scope: limits per endpoint, charging for usage, and stopping attacks at the network level.
