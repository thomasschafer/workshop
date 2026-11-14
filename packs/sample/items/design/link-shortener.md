+++
kind = "design"
skills = ["systems.reliability"]
minutes = 30
+++
Design a service that turns long links into short ones, and sends anyone who opens a short link on to the long one. Expect far more links opened than made.

## Rubric

- Estimates how many links are made and opened per second, and how much is stored
- Chooses how short codes are made, and how collisions are avoided or handled
- Serves opened links from a cache, and says what happens when the cache misses
- Says what happens when the store is unavailable
- Considers links that expire, or that are made to abuse the service

## Notes

A good answer usually separates the rarely used path, making a link, from the busy one, opening it, and sizes each on its own.
