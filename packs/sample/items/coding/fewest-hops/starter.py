import sys


def fewest_hops(n: int, roads: list[tuple[int, int]]) -> int:
    raise NotImplementedError("your code here")


def main() -> None:
    data = [int(x) for x in sys.stdin.read().split()]
    n, m = data[0], data[1]
    roads = [(data[2 + 2 * i], data[3 + 2 * i]) for i in range(m)]
    print(fewest_hops(n, roads))


main()
