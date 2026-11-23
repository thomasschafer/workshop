"""Workshop's driver for coding problems in API mode.

It reads calls on stdin, one JSON array a line: the name called, then its arguments. A call to
the class makes a new object, and any other call is to a method of the object made last, or
with no class, to one of the module's functions. What each call returns is printed as JSON, a
line each, for Workshop to compare with what was expected.

Given `--names`, it calls nothing, and only says whether the module has every name the calls
use, so a starter can be checked to define what the tests call, unfinished as it is.

The calls are read before the learner's module is imported, and the results are written to a
descriptor of the driver's own, with the learner's stdout, at every level, going to stderr. So
nothing the learner's code reads or prints, even by accident, can change what's compared.
"""

import json
import os
import sys

# The class the calls make, or None when they're to the module's functions. Workshop sets it.
CLASS = None

# What the driver exits with when the code doesn't have what the tests call, as opposed to
# going wrong as it runs.
MISSING = 3


def main():
    checking_names = sys.argv[1:] == ["--names"]
    calls = [json.loads(line) for line in sys.stdin.read().splitlines() if line.strip()]
    sys.stdin = open(os.devnull)
    sys.stdout.flush()
    results = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.__stdout__ = sys.stderr

    def fail(message, code=1):
        print(message, file=sys.stderr)
        results.flush()
        sys.exit(code)

    import solution

    owner = solution
    if CLASS is not None:
        if not isinstance(getattr(solution, CLASS, None), type):
            fail(f"There's no class {CLASS} in your code, and the tests make one.", MISSING)
        owner = None

    def missing(name):
        where = f"{CLASS} has" if CLASS is not None else "Your code has"
        fail(f"{where} no {name} to call, and the tests call it.", MISSING)

    if checking_names:
        within = getattr(solution, CLASS) if CLASS is not None else solution
        for name, *_ in calls:
            if name != CLASS and not callable(getattr(within, name, None)):
                missing(name)
        return

    for number, (name, *args) in enumerate(calls, 1):
        if CLASS is not None and name == CLASS:
            owner = getattr(solution, CLASS)(*args)
            continue
        if owner is None:
            fail(f"Call {number} is to {name} before a {CLASS} is made.")
        method = getattr(owner, name, None)
        if not callable(method):
            missing(name)
        result = method(*args)
        try:
            text = json.dumps(result, ensure_ascii=False, sort_keys=True, allow_nan=False)
        except (TypeError, ValueError):
            fail(
                f"{name} returned {result!r}, which can't be compared: return None, a bool, a "
                "number, a string, or a list or dict of them."
            )
        results.write(text + "\n")
        # Written as it goes, so what came before a crash is kept.
        results.flush()


main()
