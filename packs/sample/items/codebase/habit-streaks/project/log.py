"""The habit log: a line for each habit done on a day, such as `2026-03-09 reading`."""

import datetime


def read_log(path):
    """Each habit in the log at `path`, with the set of days it was done on."""
    days = {}
    with open(path, encoding="utf-8") as file:
        for line in file:
            line = line.strip()
            if not line or line.startswith("#"):
                continue
            day, habit = line.split(maxsplit=1)
            days.setdefault(habit, set()).add(datetime.date.fromisoformat(day))
    return days


def mark_done(path, habit):
    """Adds a line to the log saying `habit` was done today."""
    with open(path, "a", encoding="utf-8") as file:
        file.write(f"{datetime.date.today().isoformat()} {habit}\n")
