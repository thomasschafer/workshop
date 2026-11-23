import json
import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
items = ["cups", "ink", "pens", "tape"][: rng.randint(1, 4)]
print(json.dumps(["Stock"]))
for _ in range(rng.randint(1, 4 * size)):
    method = rng.choice(["add", "sell", "count"])
    if method == "low":
        print(json.dumps(["low", rng.randint(1, 6)]))
    elif method == "count":
        print(json.dumps(["count", rng.choice(items)]))
    else:
        print(json.dumps([method, rng.choice(items), rng.randint(1, 5)]))
