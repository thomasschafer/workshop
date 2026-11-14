import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
n = rng.randint(1, 3 * size)
spread = rng.choice([1, size, 50])
numbers = [rng.randint(-spread, spread) for _ in range(n)]
target = rng.randint(-2 * spread, 2 * spread)
print(n, target)
print(" ".join(map(str, numbers)))
