+++
kind = "design"
skills = ["systems.reliability", "systems.scaling"]
minutes = 30
+++
Design a service that sends notifications to people's phones when something they follow changes. Most changes are followed by a handful of people, but a few are followed by millions.

## Rubric

- Estimates how many notifications are sent per second at peak, and how much each follower list holds
- Separates accepting a change from sending its notifications, such as with a queue
- Handles changes with millions of followers without delaying everyone else's
- Retries failed sends without sending anything twice, and gives up on devices that are gone
- Respects each person's settings, such as quiet hours and how often they're sent anything

## Notes

The interesting part is the fan-out: a change followed by millions can't be sent in one go, so it's split into batches that share capacity fairly with the rest.
