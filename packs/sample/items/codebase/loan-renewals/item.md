+++
kind = "codebase"
task = "review"
title = "Reviewing loan renewals"
skills = ["code-review"]
difficulty = 2
minutes = 15

project = "project"
change = "change.diff"
+++
A library's loan system lends books for three weeks. This change lets a member renew a loan:
another two weeks, at most twice, and not once it's overdue or while someone is waiting for the
book. It comes with tests, which pass.

Review it as you would a colleague's change: say what's wrong, and where.

## Defects

- `loans.py:47`: The renewal limit is off by one: `>` lets a loan be renewed a third time, as
  `renewals` is 2 after the second; it should be `>=`.
- `loans.py:51`: The new due date is counted from today rather than from when it was due, so
  renewing early shortens the loan: renewing on the day it's lent makes it due in two weeks,
  not five.
- `loans.py:44-53`: Renewing never checks the book's reservations, though the docstring says
  it does, so a member can keep renewing a book someone else is waiting for.

## Notes

The tests only renew on the due date, which is why counting from today goes unnoticed, and
only renew twice, so the limit is never reached. A comment that the tests miss these cases is
fair. Renewing a book that isn't out raises a `KeyError` rather than a `LoanError`; that's
right to point out too, though it isn't one of the planted defects.
