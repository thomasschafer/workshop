import sys
from collections import deque


def fewest_hops(n: int, roads: list[tuple[int, int]]) -> int:
    neighbours: list[list[int]] = [[] for _ in range(n + 1)]
    for a, b in roads:
        neighbours[a].append(b)
        neighbours[b].append(a)
    distance = [-1] * (n + 1)
    distance[1] = 0
    queue = deque([1])
    while queue:
        town = queue.popleft()
        for next_town in neighbours[town]:
            if distance[next_town] == -1:
                distance[next_town] = distance[town] + 1
                queue.append(next_town)
    return distance[n]


def main() -> None:
    data = [int(x) for x in sys.stdin.read().split()]
    n, m = data[0], data[1]
    roads = [(data[2 + 2 * i], data[3 + 2 * i]) for i in range(m)]
    print(fewest_hops(n, roads))


main()
