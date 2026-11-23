"""Workshop's driver for coding problems in API mode.

It reads calls on stdin, one JSON array a line: the name called, then its arguments. A call to
the class makes a new object, and any other call is to a method of the object made last, or
with no class, to one of the module's functions. What each call returns is printed as JSON, a
line each, for Workshop to compare with what was expected.

What the learner's code prints goes to stderr, so it can't be taken for a result.
"""

import json
import sys

# The class the calls make, or None when they're to the module's functions. Workshop sets it.
CLASS = None

results = sys.stdout
sys.stdout = sys.stderr


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(1)


import solution  # noqa: E402

owner = solution
if CLASS is not None:
    if not isinstance(getattr(solution, CLASS, None), type):
        fail(f"There's no class {CLASS} in your code, and the tests make one.")
    owner = None

for number, line in enumerate(sys.stdin, 1):
    if not line.strip():
        continue
    name, *args = json.loads(line)
    if CLASS is not None and name == CLASS:
        owner = getattr(solution, CLASS)(*args)
        continue
    if owner is None:
        fail(f"Line {number} calls {name} before a {CLASS} is made.")
    method = getattr(owner, name, None)
    if not callable(method):
        where = f"{CLASS} has" if CLASS is not None else "Your code has"
        fail(f"{where} no {name} to call, and the tests call it.")
    result = method(*args)
    try:
        text = json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False)
    except (TypeError, ValueError):
        fail(
            f"{name} returned {result!r}, which can't be compared: return None, a bool, a "
            "number, a string, or a list or dict of them."
        )
    results.write(text + "\n")
