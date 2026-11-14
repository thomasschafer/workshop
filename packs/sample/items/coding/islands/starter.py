import sys


def count_islands(grid: list[str]) -> int:
    raise NotImplementedError("your code here")


def main() -> None:
    lines = sys.stdin.read().split()
    rows = int(lines[0])
    print(count_islands(lines[2 : 2 + rows]))


main()
