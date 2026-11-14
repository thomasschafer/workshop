import sys


def longest_common(first: str, second: str) -> int:
    previous = [0] * (len(second) + 1)
    for a in first:
        current = [0]
        for j, b in enumerate(second):
            current.append(previous[j] + 1 if a == b else max(previous[j + 1], current[j]))
        previous = current
    return previous[-1]


def main() -> None:
    first, second = sys.stdin.read().split()
    print(longest_common(first, second))


main()
