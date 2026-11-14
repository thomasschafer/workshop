import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
n = rng.randint(1, 3 * size)
spread = rng.choice([2, size + 1, 1000])
print(n)
print(" ".join(str(rng.randint(-spread, spread)) for _ in range(n)))
