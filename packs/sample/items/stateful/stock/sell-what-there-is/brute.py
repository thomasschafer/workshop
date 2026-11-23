class Stock:
    def __init__(self):
        self.units = []
        self.arrived = []

    def add(self, item, count):
        self.units.extend([item] * count)
        if item not in self.arrived:
            self.arrived.append(item)

    def sell(self, item, count):
        sold = 0
        while sold < count and item in self.units:
            self.units.remove(item)
            sold += 1
        return sold

    def count(self, item):
        return self.units.count(item)

    def low(self, limit):
        return sorted(item for item in self.arrived if self.units.count(item) < limit)
