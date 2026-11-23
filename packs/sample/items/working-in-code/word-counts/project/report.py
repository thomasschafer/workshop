"""A short report on a text, a line per figure."""

from stats import distinct_words, most_common, word_count


def report(text, top=3):
    lines = [
        f"Words: {word_count(text)}",
        f"Different words: {distinct_words(text)}",
    ]
    for word, count in most_common(text, top):
        lines.append(f"  {word}: {count}")
    return "\n".join(lines)
