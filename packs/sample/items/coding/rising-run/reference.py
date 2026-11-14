import sys


def longest_rise(readings: list[int]) -> int:
    best = run = 1
    for before, after in zip(readings, readings[1:]):
        run = run + 1 if after > before else 1
        best = max(best, run)
    return best


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    readings = [int(x) for x in data[1 : 1 + n]]
    print(longest_rise(readings))


main()
