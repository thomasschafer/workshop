"""The habit log: a line for each habit done on a day, such as `2026-03-09 reading`."""

import datetime


def parse_log(lines):
    """Each habit in the log's lines, with the set of days it was done on."""
    days = {}
    for line in lines:
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        day, habit = line.split(maxsplit=1)
        days.setdefault(habit, set()).add(datetime.date.fromisoformat(day))
    return days


def read_lines(path):
    with open(path, encoding="utf-8") as file:
        return file.read().splitlines()


def read_log(path):
    """Each habit in the log at `path`, with the set of days it was done on."""
    return parse_log(read_lines(path))


def mark_done(path, habit, today=datetime.date.today):
    """Adds a line to the log saying `habit` was done today."""
    with open(path, "a", encoding="utf-8") as file:
        file.write(f"{today().isoformat()} {habit}\n")
