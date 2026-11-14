import sys


def count_pairs(numbers: list[int], target: int) -> int:
    raise NotImplementedError("your code here")


def main() -> None:
    data = sys.stdin.read().split()
    n, target = int(data[0]), int(data[1])
    numbers = [int(x) for x in data[2 : 2 + n]]
    print(count_pairs(numbers, target))


main()
