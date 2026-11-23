class Stock:
    def __init__(self):
        # Every unit in stock, one entry each.
        self.units = []

    def add(self, item, count):
        self.units.extend([item] * count)

    def sell(self, item, count):
        if self.units.count(item) < count:
            return False
        for _ in range(count):
            self.units.remove(item)
        return True

    def count(self, item):
        return self.units.count(item)
