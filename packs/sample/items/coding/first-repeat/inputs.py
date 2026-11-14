import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
vocabulary = ["ash", "bay", "cove", "dune", "elm", "fen", "glen", "heath", "isle", "jetty"]
words = rng.sample(vocabulary, rng.randint(1, len(vocabulary)))
count = rng.randint(1, 2 * size)
print(" ".join(rng.choice(words) for _ in range(count)))
