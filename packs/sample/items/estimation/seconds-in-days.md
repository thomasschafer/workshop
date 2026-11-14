+++
kind = "mental-maths"
skills = ["estimation.magnitudes"]
track = "estimation"
answer = "d * 86400 / 1000000.0"
relative_tolerance = 0.05

[params]
d = { min = 9, max = 800 }

[derived]
rough = "d / 10.0"
better = "sig(d / 10.0 * 6.0 / 7.0, 3)"
+++
Roughly how many million seconds are there in {d} days?

## Method

A day is 86,400 seconds, nearly 10⁵, so {d} days is under {rough} million. 86,400 is about a
seventh short of 100,000, so take off a seventh: about {better} million. It's worth knowing that
a million seconds is about 11½ days, and a year is about π × 10⁷ seconds.
