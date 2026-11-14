import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
n = rng.randint(1, 2 * size)
broken = sorted(rng.sample(range(1, n), rng.randint(0, (n - 1) // 3))) if n > 1 else []
print(n, len(broken))
print(" ".join(map(str, broken)))
