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

## Brief

- Who uses it: anyone can open a short link. Making links needs an account; most are made through an API by a few thousand organisations, for their emails, posters and messages.
- What it must do: make a short link from a long one, open a short link, delete a link of your own, and see how many times each of your links was opened, by day. Changing where a link points isn't needed.
- Codes: letters and digits only, as short as they can be, and not guessable by counting. Accounts can choose a code of their own, such as an event's name, if it's free.
- Making links: about 2 million a day, fairly evenly through the day.
- Opening links: about 200 opens for each link made, most of them in the week after it's made. Peaks are five times the average.
- Storage: long links average 300 bytes. Links are kept for five years, unless deleted or made to expire sooner, which an account can choose when making one.
- Latency: opening a link should take under 20 ms at the 99th percentile, from the request reaching the service to the redirect. Making one can take up to a second.
- Availability: opening links matters most, at 99.99%, and should keep working when making links doesn't.
- Consistency: a new link must open, everywhere, within a few seconds of being made. Open counts can be minutes behind.
- Abuse: links reported as leading to malware must stop working within an hour.
- Out of scope: previews of where a link goes, a website for browsing links, and billing.
