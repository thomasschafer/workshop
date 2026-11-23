class Stock:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def add(self, item: str, count: int) -> None:
        self.counts[item] = self.counts.get(item, 0) + count

    def sell(self, item: str, count: int) -> bool:
        if self.counts.get(item, 0) < count:
            return False
        self.counts[item] -= count
        return True

    def count(self, item: str) -> int:
        return self.counts.get(item, 0)
