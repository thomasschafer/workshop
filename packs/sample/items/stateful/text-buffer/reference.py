class TextBuffer:
    def __init__(self) -> None:
        self.chars: list[str] = []

    def insert(self, text: str) -> None:
        self.chars.extend(text)

    def delete(self, count: int) -> None:
        del self.chars[max(0, len(self.chars) - count) :]

    def text(self) -> str:
        return "".join(self.chars)
