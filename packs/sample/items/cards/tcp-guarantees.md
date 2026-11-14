+++
kind = "card"
skills = ["systems.networking"]
+++
What does TCP guarantee about the data it carries that UDP doesn't?

## Answer

That it arrives, in order, without duplicates, or the connection reports an error.

## Explanation

TCP numbers its bytes, acknowledges them and resends what's lost, and also slows down when the
network is congested. UDP sends each datagram once, and they can be lost, duplicated or reordered.
