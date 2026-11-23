class Stock:
    def __init__(self) -> None:
        pass

    def add(self, item: str, count: int) -> None:
        raise NotImplementedError("your code here")

    def sell(self, item: str, count: int) -> bool:
        raise NotImplementedError("your code here")

    def count(self, item: str) -> int:
        raise NotImplementedError("your code here")
