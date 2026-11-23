import datetime

from tracker import Tracker

MARCH_10 = datetime.date(2026, 3, 10)


def on(day):
    return lambda: day


def tracker(lines, today):
    return Tracker(read=lambda: lines, today=on(today))


def test_counts_back_from_today():
    lines = ["2026-03-08 reading", "2026-03-09 reading", "2026-03-10 reading"]
    assert tracker(lines, MARCH_10).streak("reading") == 3


def test_a_day_missed_ends_the_streak():
    lines = ["2026-03-07 reading", "2026-03-09 reading", "2026-03-10 reading"]
    assert tracker(lines, MARCH_10).streak("reading") == 2


def test_not_done_yet_today_keeps_yesterdays_streak():
    lines = ["2026-03-08 running", "2026-03-09 running"]
    assert tracker(lines, MARCH_10).streak("running") == 2
    assert tracker(lines, datetime.date(2026, 3, 11)).streak("running") == 0


def test_summary():
    lines = ["2026-03-09 running", "2026-03-10 reading", "2026-03-09 reading"]
    assert tracker(lines, MARCH_10).summary() == ["reading: 2 days", "running: 1 days"]
