import sys

words = sys.stdin.read().split()
for j, word in enumerate(words):
    if word in words[:j]:
        print(word)
        break
else:
    print("none")
