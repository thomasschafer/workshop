import sys

MOD = 1_000_000_007


def count_ways(n: int, broken: set[int]) -> int:
    raise NotImplementedError("your code here")


def main() -> None:
    data = [int(x) for x in sys.stdin.read().split()]
    n, k = data[0], data[1]
    print(count_ways(n, set(data[2 : 2 + k])))


main()
