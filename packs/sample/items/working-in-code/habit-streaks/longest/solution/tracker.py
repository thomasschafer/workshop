"""How each habit is going, from its log."""

import datetime

from log import parse_log, read_lines

ONE_DAY = datetime.timedelta(days=1)


class Tracker:
    def __init__(self, path=None, *, read=None, today=datetime.date.today):
        """A tracker of the log at `path`, or of the lines `read` gives, with `today` saying
        what day it is."""
        if read is None:
            if path is None:
                raise ValueError("give a log's path, or a way to read its lines")
            read = lambda: read_lines(path)  # noqa: E731
        self.read = read
        self.today = today

    def days(self):
        return parse_log(self.read())

    def streak(self, habit):
        """How many days in a row `habit` has been done, up to today. A habit not done yet
        today still has its streak, as there's time to do it."""
        return streak(self.days().get(habit, set()), self.today())

    def longest(self, habit):
        """The most days in a row `habit` has ever been done."""
        return longest(self.days().get(habit, set()))

    def summary(self):
        """A line for each habit, in alphabetical order, with its streak."""
        days, today = self.days(), self.today()
        return [f"{habit}: {streak(days[habit], today)} days" for habit in sorted(days)]

    def records(self):
        """A line for each habit, in alphabetical order, with its longest streak."""
        days = self.days()
        return [f"{habit}: best {longest(days[habit])} days" for habit in sorted(days)]


def streak(days, today):
    """How many days in a row up to `today` are in `days`, or up to yesterday if today isn't."""
    day = today if today in days else today - ONE_DAY
    count = 0
    while day in days:
        count += 1
        day -= ONE_DAY
    return count


def longest(days):
    """The longest run of days in a row in `days`: counted from each day that starts one."""
    best = 0
    for day in days:
        if day - ONE_DAY not in days:
            run = 1
            while day + run * ONE_DAY in days:
                run += 1
            best = max(best, run)
    return best
