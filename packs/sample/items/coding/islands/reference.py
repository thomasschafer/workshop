import sys
from collections import deque


def count_islands(grid: list[str]) -> int:
    rows, cols = len(grid), len(grid[0])
    seen = [[False] * cols for _ in range(rows)]
    islands = 0
    for r in range(rows):
        for c in range(cols):
            if grid[r][c] != "#" or seen[r][c]:
                continue
            islands += 1
            seen[r][c] = True
            queue = deque([(r, c)])
            while queue:
                y, x = queue.popleft()
                for ny, nx in ((y - 1, x), (y + 1, x), (y, x - 1), (y, x + 1)):
                    if 0 <= ny < rows and 0 <= nx < cols and grid[ny][nx] == "#" and not seen[ny][nx]:
                        seen[ny][nx] = True
                        queue.append((ny, nx))
    return islands


def main() -> None:
    lines = sys.stdin.read().split()
    rows = int(lines[0])
    print(count_islands(lines[2 : 2 + rows]))


main()
