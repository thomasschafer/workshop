from report import report
from stats import distinct_words, most_common, word_count
from words import split_words


def test_splits_on_spaces_and_punctuation():
    assert split_words("Cats, dogs and   CATS") == ["cats", "dogs", "and", "cats"]


def test_keeps_apostrophes_inside_words():
    assert split_words("it's the dog's bowl") == ["it's", "the", "dog's", "bowl"]


def test_counts_words():
    assert word_count("one two three two") == 4
    assert distinct_words("one two three two") == 3


def test_most_common_first():
    assert most_common("b a b c a b", 2) == [("b", 3), ("a", 2)]


def test_report():
    assert report("to be or not to be", top=2) == (
        "Words: 6\nDifferent words: 4\n  be: 2\n  to: 2"
    )
