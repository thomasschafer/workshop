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

## Brief

- Who uses it: people with the app on their phones, who follow things such as a local sports club, a topic in the news or another person's posts. 80 million people have the app, and 20 million use it on a typical day. Many have more than one device.
- What it must do: follow and unfollow things, send a notification to each follower's devices when something they follow changes, and keep each person's settings: quiet hours, and the most notifications they want a day.
- Followers: most things have under 100 followers. About 1,000 have over a million, and the largest have 30 million.
- Load: about 5,000 changes a second, making about 200,000 notifications a second on average, and up to 2 million a second during big events.
- Delivery: through the phone platforms' push services, which take one message per device, and sometimes refuse, slow down or say a device is gone.
- Latency: a change with a small following reaches its followers within 5 seconds. For the largest, reaching every follower within 2 minutes is fine.
- Reliability: a device never gets the same notification twice. Missing one now and then is acceptable. Devices the push service says are gone are removed.
- Out of scope: email and text messages, what the change itself is, and choosing which changes are worth a notification.
