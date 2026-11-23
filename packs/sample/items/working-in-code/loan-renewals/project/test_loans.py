import datetime

from catalogue import Book, Catalogue
from loans import LoanError, Loans

MARCH_1 = datetime.date(2026, 3, 1)


def library():
    catalogue = Catalogue()
    catalogue.add(Book("b1", "A Short Walk"))
    catalogue.add(Book("b2", "Long Rivers"))
    return catalogue, Loans(catalogue)


def test_lends_for_three_weeks():
    _, loans = library()
    assert loans.lend("b1", "ana", MARCH_1).due == datetime.date(2026, 3, 22)


def test_a_book_out_cant_be_lent():
    _, loans = library()
    loans.lend("b1", "ana", MARCH_1)
    try:
        loans.lend("b1", "ben", MARCH_1)
    except LoanError:
        return
    raise AssertionError("lent a book that was out")


def test_the_first_to_reserve_gets_it():
    catalogue, loans = library()
    catalogue.reserve("b1", "cat")
    catalogue.reserve("b1", "dev")
    try:
        loans.lend("b1", "dev", MARCH_1)
    except LoanError:
        pass
    else:
        raise AssertionError("lent past the first reservation")
    assert loans.lend("b1", "cat", MARCH_1).member == "cat"
    assert catalogue.get("b1").reservations == ["dev"]


def test_overdue():
    _, loans = library()
    loans.lend("b1", "ana", MARCH_1)
    loans.lend("b2", "ben", MARCH_1 + datetime.timedelta(days=2))
    assert [loan.book_id for loan in loans.overdue(datetime.date(2026, 3, 25))] == ["b1", "b2"]
    assert loans.overdue(datetime.date(2026, 3, 22)) == []
