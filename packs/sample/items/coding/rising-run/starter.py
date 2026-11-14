import sys


def longest_rise(readings: list[int]) -> int:
    raise NotImplementedError("your code here")


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    readings = [int(x) for x in data[1 : 1 + n]]
    print(longest_rise(readings))


main()
