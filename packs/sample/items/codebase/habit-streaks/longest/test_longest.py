import datetime

from tracker import Tracker

MARCH_10 = datetime.date(2026, 3, 10)


def tracker(lines):
    return Tracker(read=lambda: lines, today=lambda: MARCH_10)


def test_longest_streak_ever():
    lines = ["2026-03-01 reading", "2026-03-02 reading", "2026-03-03 reading", "2026-03-10 reading"]
    assert tracker(lines).longest("reading") == 3


def test_records():
    lines = ["2026-03-01 reading", "2026-03-02 reading", "2026-03-10 reading", "2026-03-10 running"]
    assert tracker(lines).records() == ["reading: best 2 days", "running: best 1 days"]
