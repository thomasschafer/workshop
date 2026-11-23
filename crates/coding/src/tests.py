"""Workshop's driver for the tests of a codebase item's project.

It reads which test to run on stdin, as `test_loans.py::test_due_date`, imports that file of
tests from the project beside it, and calls the test. A test passes if it returns, and fails if
it raises, such as with `assert`. A test that passes prints `passed`, for Workshop to compare
with what was expected; one that fails says why on stderr.

The test to run is read before the project is imported, and `passed` is written to a
descriptor of the driver's own, with the project's stdout, at every level, going to stderr. So
nothing the project reads or prints, even by accident, can pass a test.
"""

import importlib
import os
import sys
import traceback

PASSED = "passed"

# What the driver exits with when there's no such test, as opposed to one that fails.
MISSING = 3


def main():
    test = sys.stdin.read().strip()
    sys.stdin = open(os.devnull)
    sys.stdout.flush()
    results = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.__stdout__ = sys.stderr

    file, _, name = test.partition("::")
    if not file.endswith(".py") or not name:
        print(f"{test!r} isn't a test: name it as file.py::test_name.", file=sys.stderr)
        sys.exit(MISSING)
    try:
        module = importlib.import_module(file[: -len(".py")])
    except Exception:
        print(f"Importing {file} failed:", file=sys.stderr)
        show(sys.exc_info())
        sys.exit(1)
    function = getattr(module, name, None)
    if not callable(function):
        print(f"There's no test {name} in {file}.", file=sys.stderr)
        sys.exit(MISSING)
    try:
        function()
    except AssertionError:
        print(f"{name} failed:", file=sys.stderr)
        show(sys.exc_info())
        sys.exit(1)
    except Exception:
        print(f"{name} raised an exception:", file=sys.stderr)
        show(sys.exc_info())
        sys.exit(1)
    results.write(PASSED + "\n")
    results.flush()


def show(info):
    """The traceback, from the test or the import on, without the driver's own frame."""
    kind, value, trace = info
    traceback.print_exception(kind, value, trace.tb_next if trace else None)


main()
