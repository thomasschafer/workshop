class TextBuffer:
    def __init__(self) -> None:
        self.chars: list[str] = []
        # Each change as ("insert", how many characters it added) or ("delete", what it removed).
        self.done: list[tuple[str, int | str]] = []

    def insert(self, text: str) -> None:
        self.chars.extend(text)
        self.done.append(("insert", len(text)))

    def delete(self, count: int) -> None:
        removed = self.remove(count)
        self.done.append(("delete", removed))

    def text(self) -> str:
        return "".join(self.chars)

    def undo(self) -> None:
        if not self.done:
            return
        kind, change = self.done.pop()
        if kind == "insert":
            self.remove(change)
        else:
            self.chars.extend(change)

    def remove(self, count: int) -> str:
        start = max(0, len(self.chars) - count)
        removed = "".join(self.chars[start:])
        del self.chars[start:]
        return removed
