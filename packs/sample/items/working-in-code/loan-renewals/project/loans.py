"""Lending books, and getting them back."""

import datetime

LOAN_DAYS = 21


class LoanError(Exception):
    pass


class Loan:
    def __init__(self, book_id, member, due):
        self.book_id = book_id
        self.member = member
        self.due = due


class Loans:
    def __init__(self, catalogue):
        self.catalogue = catalogue
        self.out = {}

    def lend(self, book_id, member, today):
        """Lends a book for `LOAN_DAYS` days, unless it's out, or someone else is waiting for
        it first."""
        if book_id in self.out:
            raise LoanError("that book is out already")
        waiting = self.catalogue.get(book_id).reservations
        if waiting and waiting[0] != member:
            raise LoanError("someone else is waiting for that book")
        if waiting:
            waiting.pop(0)
        loan = Loan(book_id, member, today + datetime.timedelta(days=LOAN_DAYS))
        self.out[book_id] = loan
        return loan

    def give_back(self, book_id):
        del self.out[book_id]

    def overdue(self, today):
        """The loans due back before today, the longest overdue first."""
        late = [loan for loan in self.out.values() if loan.due < today]
        return sorted(late, key=lambda loan: loan.due)
