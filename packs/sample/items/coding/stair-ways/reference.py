import sys

MOD = 1_000_000_007


def count_ways(n: int, broken: set[int]) -> int:
    ways = [0] * (n + 1)
    ways[0] = 1
    for step in range(1, n + 1):
        if step not in broken:
            ways[step] = sum(ways[max(step - 3, 0) : step]) % MOD
    return ways[n]


def main() -> None:
    data = [int(x) for x in sys.stdin.read().split()]
    n, k = data[0], data[1]
    print(count_ways(n, set(data[2 : 2 + k])))


main()
