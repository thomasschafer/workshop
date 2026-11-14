+++
kind = "mental-maths"
skills = ["estimation.magnitudes"]
track = "estimation"
answer = "n * 1000000.0 / 86400"
relative_tolerance = 0.1

[params]
n = { min = 3, max = 900 }

[derived]
rough = "n * 10"
better = "sig(n * 11.5, 3)"
+++
A service gets {n} million requests a day. Roughly how many is that a second, on average?

## Method

A day is about 10⁵ seconds (86,400), so a million a day is about 10 a second: {n} million a day
is about {rough} a second. A day is about 14% short of 10⁵, so add about 15%: {better}. Peaks
are often a few times the average, so size for those.
