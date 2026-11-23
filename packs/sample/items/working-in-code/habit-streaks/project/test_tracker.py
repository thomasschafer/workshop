import datetime
import os
import tempfile

from log import mark_done, read_log
from tracker import Tracker


def log_file(text):
    handle, path = tempfile.mkstemp(suffix=".log")
    with os.fdopen(handle, "w", encoding="utf-8") as file:
        file.write(text)
    return path


def test_reads_the_log():
    path = log_file("# a comment\n2026-03-09 reading\n\n2026-03-10 reading\n2026-03-10 running\n")
    assert read_log(path) == {
        "reading": {datetime.date(2026, 3, 9), datetime.date(2026, 3, 10)},
        "running": {datetime.date(2026, 3, 10)},
    }


def test_marking_done_starts_a_streak():
    path = log_file("")
    mark_done(path, "reading")
    assert Tracker(path).streak("reading") == 1
    assert Tracker(path).summary() == ["reading: 1 days"]


def test_a_habit_never_done_has_no_streak():
    assert Tracker(log_file("2020-01-01 reading\n")).streak("running") == 0
