import datetime

from tracker import Tracker

MARCH_10 = datetime.date(2026, 3, 10)


def tracker(lines):
    return Tracker(read=lambda: lines, today=lambda: MARCH_10)


def test_a_habit_never_done():
    assert tracker(["2026-03-10 reading"]).longest("running") == 0


def test_the_current_streak_can_be_the_best():
    lines = ["2026-03-08 reading", "2026-03-09 reading", "2026-03-10 reading", "2026-03-01 reading"]
    assert tracker(lines).longest("reading") == 3
    assert tracker(lines).records() == ["reading: best 3 days"]
    assert tracker(lines).summary() == ["reading: 3 days"]


def test_across_the_end_of_a_month():
    lines = ["2026-02-27 running", "2026-02-28 running", "2026-03-01 running"]
    assert tracker(lines).longest("running") == 3


def test_days_in_any_order():
    lines = ["2026-03-05 reading", "2026-03-03 reading", "2026-03-04 reading", "2026-03-01 reading"]
    assert tracker(lines).longest("reading") == 3
