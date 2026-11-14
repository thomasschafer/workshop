import sys
from collections import Counter


def count_pairs(numbers: list[int], target: int) -> int:
    seen: Counter[int] = Counter()
    pairs = 0
    for number in numbers:
        pairs += seen[target - number]
        seen[number] += 1
    return pairs


def main() -> None:
    data = sys.stdin.read().split()
    n, target = int(data[0]), int(data[1])
    numbers = [int(x) for x in data[2 : 2 + n]]
    print(count_pairs(numbers, target))


main()
