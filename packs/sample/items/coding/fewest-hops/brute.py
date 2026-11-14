import sys

# Distances are relaxed along every road until none gets shorter, as Bellman-Ford does.
data = [int(x) for x in sys.stdin.read().split()]
n, m = data[0], data[1]
roads = [(data[2 + 2 * i], data[3 + 2 * i]) for i in range(m)]
far = n + 1
distance = [far] * (n + 1)
distance[1] = 0
for _ in range(n):
    for a, b in roads:
        distance[b] = min(distance[b], distance[a] + 1)
        distance[a] = min(distance[a], distance[b] + 1)
print(distance[n] if distance[n] < far else -1)
