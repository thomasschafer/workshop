import sys

data = sys.stdin.read().split()
n = int(data[0])
changes = [int(x) for x in data[1 : 1 + n]]
print(min([0] + [sum(changes[: day + 1]) for day in range(n)]))
