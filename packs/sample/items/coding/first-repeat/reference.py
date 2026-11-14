import sys


def first_repeat(words: list[str]) -> str:
    seen: set[str] = set()
    for word in words:
        if word in seen:
            return word
        seen.add(word)
    return "none"


def main() -> None:
    print(first_repeat(sys.stdin.read().split()))


main()
