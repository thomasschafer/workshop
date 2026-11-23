"""Counting the words in a text."""

from collections import Counter

from words import split_words


def word_count(text):
    """How many words there are in `text`."""
    return len(split_words(text))


def distinct_words(text):
    """How many different words there are in `text`."""
    return len(set(split_words(text)))


def most_common(text, n):
    """The `n` most common words, each with how often it appears, most common first, and
    alphabetically among those that appear as often."""
    counts = Counter(split_words(text))
    return sorted(counts.items(), key=lambda pair: (-pair[1], pair[0]))[:n]
