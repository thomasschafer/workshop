import sys

# Every land square starts with a label of its own, and takes the smallest label beside it until
# nothing changes. Then each island has one label.
lines = sys.stdin.read().split()
rows, cols = int(lines[0]), int(lines[1])
grid = lines[2 : 2 + rows]
label = {(r, c): r * cols + c for r in range(rows) for c in range(cols) if grid[r][c] == "#"}
changed = True
while changed:
    changed = False
    for (r, c), current in label.items():
        smallest = min(
            [current] + [label[n] for n in ((r - 1, c), (r + 1, c), (r, c - 1), (r, c + 1)) if n in label]
        )
        if smallest < current:
            label[(r, c)] = smallest
            changed = True
print(len(set(label.values())))
