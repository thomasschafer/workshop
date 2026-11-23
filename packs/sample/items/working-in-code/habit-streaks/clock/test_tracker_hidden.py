import datetime

from tracker import Tracker


def test_the_clock_is_asked_each_time():
    days = iter([datetime.date(2026, 3, 10), datetime.date(2026, 3, 12)])
    tracker = Tracker(read=lambda: ["2026-03-09 reading", "2026-03-10 reading"], today=lambda: next(days))
    assert tracker.streak("reading") == 2
    assert tracker.streak("reading") == 0


def test_reads_the_log_each_time():
    lines = ["2026-03-10 reading"]
    tracker = Tracker(read=lambda: list(lines), today=lambda: datetime.date(2026, 3, 10))
    assert tracker.streak("reading") == 1
    lines.insert(0, "2026-03-09 reading")
    assert tracker.streak("reading") == 2


def test_comments_and_blank_lines_are_skipped():
    tracker = Tracker(
        read=lambda: ["# notes", "", "2026-03-10 reading"],
        today=lambda: datetime.date(2026, 3, 10),
    )
    assert tracker.summary() == ["reading: 1 days"]
