"""Splitting text into words."""

import re

# Letters, digits and apostrophes make words; anything else is between them.
_BETWEEN = re.compile(r"[^a-z0-9']+")


def split_words(text):
    """The words in `text`, in order, lowercased, without the punctuation around them."""
    words = _BETWEEN.split(text.lower())
    return [word.strip("'") for word in words]
