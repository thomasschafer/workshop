import sys

data = sys.stdin.read().split()
n = int(data[0])
readings = [int(x) for x in data[1 : 1 + n]]
best = 0
for start in range(n):
    for end in range(start, n):
        stretch = readings[start : end + 1]
        if all(a < b for a, b in zip(stretch, stretch[1:])):
            best = max(best, len(stretch))
print(best)
