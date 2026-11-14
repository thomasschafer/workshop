import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
rows, cols = rng.randint(1, size + 1), rng.randint(1, size + 1)
land = rng.choice([0.2, 0.45, 0.7])
print(rows, cols)
for _ in range(rows):
    print("".join("#" if rng.random() < land else "." for _ in range(cols)))
