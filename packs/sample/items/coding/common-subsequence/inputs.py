import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
letters = "abc"[: rng.randint(1, 3)] if rng.random() < 0.5 else "abcdefgh"
for _ in range(2):
    print("".join(rng.choice(letters) for _ in range(rng.randint(1, size + 2))))
