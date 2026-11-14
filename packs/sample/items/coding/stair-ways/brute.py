import sys

# Tries every sequence of moves, which is slow but plainly what's asked.
data = [int(x) for x in sys.stdin.read().split()]
n, k = data[0], data[1]
broken = set(data[2 : 2 + k])


def climbs(step: int) -> int:
    if step == n:
        return 1
    if step > n or step in broken:
        return 0
    return climbs(step + 1) + climbs(step + 2) + climbs(step + 3)


print(climbs(0) % 1_000_000_007)
