import sys


def lowest_balance(changes: list[int]) -> int:
    balance = lowest = 0
    for change in changes:
        balance += change
        lowest = min(lowest, balance)
    return lowest


def main() -> None:
    data = sys.stdin.read().split()
    n = int(data[0])
    changes = [int(x) for x in data[1 : 1 + n]]
    print(lowest_balance(changes))


main()
