import sys

data = sys.stdin.read().split()
n, target = int(data[0]), int(data[1])
numbers = [int(x) for x in data[2 : 2 + n]]
print(sum(1 for i in range(n) for j in range(i + 1, n) if numbers[i] + numbers[j] == target))
