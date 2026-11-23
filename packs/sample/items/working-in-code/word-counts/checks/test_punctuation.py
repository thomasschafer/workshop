from report import report
from stats import distinct_words, most_common, word_count
from words import split_words


def test_ends_with_a_full_stop():
    assert word_count("The cat sat.") == 3, word_count("The cat sat.")
    assert distinct_words("The cat sat.") == 3


def test_starts_with_a_quote():
    assert split_words('"Hello," she said') == ["hello", "she", "said"]


def test_only_punctuation():
    assert word_count("...!?") == 0
    assert distinct_words("") == 0


def test_quoted_words_are_not_empty():
    assert split_words("say 'yes' now") == ["say", "yes", "now"]
    assert split_words("' '") == []


def test_report_of_a_sentence():
    assert report("Yes. Yes! No?", top=2) == "Words: 3\nDifferent words: 2\n  yes: 2\n  no: 1"


def test_most_common_has_no_blank_word():
    assert all(word for word, _ in most_common("a, b. c! a?", 5))
