class Stock:
    def __init__(self) -> None:
        self.counts: dict[str, int] = {}

    def add(self, item: str, count: int) -> None:
        self.counts[item] = self.counts.get(item, 0) + count

    def sell(self, item: str, count: int) -> int:
        sold = min(count, self.counts.get(item, 0))
        if sold:
            self.counts[item] -= sold
        return sold

    def count(self, item: str) -> int:
        return self.counts.get(item, 0)

    def low(self, limit: int) -> list[str]:
        return sorted(item for item, count in self.counts.items() if count < limit)
