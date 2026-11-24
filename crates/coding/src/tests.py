"""Workshop's driver for the tests of a codebase item's project.

It reads which test to run on stdin, as `test_loans.py::test_due_date`, loads that file of tests,
and calls the test. A test passes if it returns, and fails if it raises, such as with `assert`.
A test that passes prints `passed`, for Workshop to compare with what was expected; one that
fails says why on stderr.

The project is in `project/`, beside the driver, with the tests the learner can see, and the
hidden tests, when there are any, in `hidden/`. Python is started isolated (`-I`), and the
driver imports everything it needs before the project is put at the end of the import path, so
a project's file named like a module of Python's own, such as `traceback.py`, can't stand in for
it. The project runs in its own directory, where the hidden tests aren't, and they're loaded from
where they are rather than from the import path.

The test to run is read before the project is imported, and `passed` is written to a descriptor
of the driver's own, with the project's stdout, at every level, going to stderr, so nothing the
project prints by accident can pass a test. The project runs in the same process, so code that
sets out to forge a pass can; that's not defended against, as it would only fool its writer.
"""

import importlib
import importlib.util
import os
import sys
import traceback

PASSED = "passed"

# What the driver exits with when there's no such test, as opposed to one that fails.
MISSING = 3

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.join(HERE, "project")
HIDDEN = os.path.join(HERE, "hidden")


def main():
    test = sys.stdin.read().strip()
    sys.stdin = open(os.devnull)
    sys.stdout.flush()
    # Not inherited by anything the project starts.
    results = os.fdopen(os.dup(1), "w", encoding="utf-8")
    os.dup2(2, 1)
    sys.stdout = sys.__stdout__ = sys.stderr

    file, _, name = test.partition("::")
    if not file.endswith(".py") or not name:
        print(f"{test!r} isn't a test: name it as file.py::test_name.", file=sys.stderr)
        sys.exit(MISSING)
    os.chdir(PROJECT)
    sys.path.append(PROJECT)
    module = load(file)
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


def load(file):
    """A file of tests, as a module: the project's own, or a hidden one, from where it is."""
    module = file[: -len(".py")]
    try:
        if os.path.isfile(os.path.join(PROJECT, file)):
            return importlib.import_module(module)
        path = os.path.join(HIDDEN, file)
        if not os.path.isfile(path):
            print(f"There's no file of tests {file}.", file=sys.stderr)
            sys.exit(MISSING)
        spec = importlib.util.spec_from_file_location(module, path)
        loaded = importlib.util.module_from_spec(spec)
        sys.modules[module] = loaded
        spec.loader.exec_module(loaded)
        return loaded
    except Exception:
        print(f"Importing {file} failed:", file=sys.stderr)
        show(sys.exc_info())
        sys.exit(1)


def show(info):
    """The traceback, from the test or the import on, without the driver's own frames."""
    kind, value, trace = info
    while trace is not None and trace.tb_frame.f_code.co_filename == __file__:
        trace = trace.tb_next
    traceback.print_exception(kind, value, trace)


main()
