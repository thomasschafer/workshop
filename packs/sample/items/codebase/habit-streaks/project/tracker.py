"""How each habit is going, from its log."""

import datetime

from log import read_log


class Tracker:
    def __init__(self, path):
        self.path = path

    def streak(self, habit):
        """How many days in a row `habit` has been done, up to today. A habit not done yet
        today still has its streak, as there's time to do it."""
        days = read_log(self.path).get(habit, set())
        day = datetime.date.today()
        if day not in days:
            day -= datetime.timedelta(days=1)
        count = 0
        while day in days:
            count += 1
            day -= datetime.timedelta(days=1)
        return count

    def summary(self):
        """A line for each habit, in alphabetical order, with its streak."""
        habits = sorted(read_log(self.path))
        return [f"{habit}: {self.streak(habit)} days" for habit in habits]
