import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
n = rng.randint(1, 3 * size)
spread = rng.choice([1, size + 1, 1000])
# Sometimes mostly rises, so the lowest is often the start.
lean = rng.choice([0, 0, spread // 2])
print(n)
print(" ".join(str(max(-1000, min(1000, rng.randint(-spread, spread) + lean))) for _ in range(n)))
