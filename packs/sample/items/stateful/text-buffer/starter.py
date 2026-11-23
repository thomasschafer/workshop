class TextBuffer:
    def __init__(self) -> None:
        pass

    def insert(self, text: str) -> None:
        raise NotImplementedError("your code here")

    def delete(self, count: int) -> None:
        raise NotImplementedError("your code here")

    def text(self) -> str:
        raise NotImplementedError("your code here")
