import sys


def longest_common(first: str, second: str) -> int:
    raise NotImplementedError("your code here")


def main() -> None:
    first, second = sys.stdin.read().split()
    print(longest_common(first, second))


main()
