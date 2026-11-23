"""The library's books, and who's waiting for each."""

from dataclasses import dataclass, field


@dataclass
class Book:
    id: str
    title: str
    # Members waiting for it, in the order they asked.
    reservations: list = field(default_factory=list)


class Catalogue:
    def __init__(self):
        self.books = {}

    def add(self, book):
        self.books[book.id] = book

    def get(self, book_id):
        return self.books[book_id]

    def reserve(self, book_id, member):
        book = self.get(book_id)
        if member not in book.reservations:
            book.reservations.append(member)
