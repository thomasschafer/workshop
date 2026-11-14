import sys
from itertools import combinations

# Tries every subsequence of the shorter word, longest first.
first, second = sys.stdin.read().split()
short, long = sorted((first, second), key=len)


def is_subsequence(part: str, word: str) -> bool:
    letters = iter(word)
    return all(letter in letters for letter in part)


for length in range(len(short), -1, -1):
    if any(is_subsequence("".join(c), long) for c in combinations(short, length)):
        print(length)
        break
