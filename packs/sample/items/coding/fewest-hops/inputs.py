import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
n = rng.randint(1, size + 2)
m = rng.randint(0, 2 * n)
print(n, m)
for _ in range(m):
    print(rng.randint(1, n), rng.randint(1, n))
