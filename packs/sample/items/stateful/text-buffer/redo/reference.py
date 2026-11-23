class TextBuffer:
    def __init__(self) -> None:
        self.chars: list[str] = []
        # Each change as ("insert", the text it added) or ("delete", what it removed).
        self.done: list[tuple[str, str]] = []
        self.undone: list[tuple[str, str]] = []

    def insert(self, text: str) -> None:
        self.make(("insert", text))
        self.undone.clear()

    def delete(self, count: int) -> None:
        start = max(0, len(self.chars) - count)
        self.make(("delete", "".join(self.chars[start:])))
        self.undone.clear()

    def text(self) -> str:
        return "".join(self.chars)

    def undo(self) -> None:
        if not self.done:
            return
        kind, change = self.done.pop()
        if kind == "insert":
            del self.chars[len(self.chars) - len(change) :]
        else:
            self.chars.extend(change)
        self.undone.append((kind, change))

    def redo(self) -> None:
        if self.undone:
            self.make(self.undone.pop())

    def make(self, change: tuple[str, str]) -> None:
        kind, text = change
        if kind == "insert":
            self.chars.extend(text)
        else:
            del self.chars[len(self.chars) - len(text) :]
        self.done.append(change)
