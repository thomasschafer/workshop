+++
kind = "mental-maths"
skills = ["estimation.arithmetic"]
track = "estimation"
answer = "v / 3.6"
relative_tolerance = 0.05

[params]
v = { min = 37, max = 287 }

[derived]
quarter = "sig(v / 4.0, 3)"
rough = "sig(v / 4.0 * 1.1, 3)"
+++
Roughly how many metres a second is {v} km/h?

## Method

A kilometre an hour is 1000 m in 3600 s, so divide by 3.6. Dividing by 4 is easier, two
halvings: {quarter}. That's a tenth too low, so add a tenth: about {rough} m/s.
