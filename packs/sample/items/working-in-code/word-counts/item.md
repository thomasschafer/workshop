+++
kind = "codebase"
task = "fix"
title = "Word counts that are one too many"
skills = ["debugging"]
difficulty = 2
minutes = 15

project = "project"
tests = ["checks/test_punctuation.py"]
reference = "fixed"
+++
This small tool reports on a text: how many words it has, how many different words, and the
most common ones. Its tests pass, but people using it say the counts are sometimes one too
many: "The cat sat." has 4 words, it says, and 4 different words.

Find out why, and fix it, changing as little as you can.

## Explanation

`split_words` splits the text wherever there's something that isn't part of a word. Where the
text starts or ends with punctuation, such as a full stop, `re.split` gives an empty string at
that end, and a word made only of apostrophes is stripped down to one too. So the empty string
is counted as a word, and as a different word, and can even be one of the most common.

The fix is to leave out empty words in `split_words`, after stripping apostrophes, so every
caller gets only real words. Fixing it in `word_count` and `distinct_words` instead would miss
`most_common`, and any caller added later.

## Hints

- Try `split_words` on "The cat sat." in your head, or add a test for it.
- What does `re.split` give when the pattern matches at the very start or end of the text?
