"""How each habit is going, from its log."""

import datetime

from log import parse_log, read_lines


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

    def summary(self):
        """A line for each habit, in alphabetical order, with its streak."""
        days, today = self.days(), self.today()
        return [f"{habit}: {streak(days[habit], today)} days" for habit in sorted(days)]


def streak(days, today):
    """How many days in a row up to `today` are in `days`, or up to yesterday if today isn't."""
    day = today if today in days else today - datetime.timedelta(days=1)
    count = 0
    while day in days:
        count += 1
        day -= datetime.timedelta(days=1)
    return count
