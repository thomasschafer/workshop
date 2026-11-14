+++
kind = "mental-maths"
skills = ["estimation.magnitudes"]
track = "estimation"
answer = "n * kb / 1000.0"
factor = 2

[params]
n = { min = 20, max = 900 }
kb = { choices = [2, 3, 4, 6, 8, 12, 16, 24, 48, 64] }

[derived]
gb = "n * kb"
+++
A store holds {n} million records of {kb} KB each. Roughly how many terabytes is that?

## Method

Count powers of ten: a million records of a kilobyte is 10⁶ × 10³ = 10⁹ bytes, a gigabyte. So
it's {n} × {kb} = {gb} GB, and a thousand gigabytes is a terabyte. For sizing, being within a
factor of two is usually enough: replicas, indexes and headroom change it more than that.
