import json
import random
import sys

seed, size = int(sys.argv[1]), int(sys.argv[2])
rng = random.Random(seed)
print(json.dumps(["TextBuffer"]))
for _ in range(rng.randint(1, 4 * size)):
    method = rng.choice(["insert", "delete", "text"])
    if method == "insert":
        word = "".join(rng.choice("abc") for _ in range(rng.randint(0, 3)))
        print(json.dumps(["insert", word]))
    elif method == "delete":
        print(json.dumps(["delete", rng.randint(0, 4)]))
    else:
        print(json.dumps([method]))
print(json.dumps(["text"]))
