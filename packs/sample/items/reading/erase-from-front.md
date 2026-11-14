+++
kind = "reading"
title = "Erasing from the front of a vector"
skills = ["cpp.costs"]
choices = [
  "O(1): it only marks the first element as gone",
  "O(log n)",
  "O(n): every later element moves down one place",
  "O(n log n)",
]
answer = 3

# The program counts the moves erasing makes, which shows the cost.
[check]
expect = "output"
output = "999"
+++
For a vector of n elements, how much work does `v.erase(v.begin())` do?

```cpp
#include <iostream>
#include <vector>

struct Counted {
    static inline long moves = 0;
    int value;
    Counted(int v) : value(v) {}
    Counted(const Counted& other) = default;
    Counted(Counted&& other) noexcept : value(other.value) { ++moves; }
    Counted& operator=(const Counted& other) = default;
    Counted& operator=(Counted&& other) noexcept {
        value = other.value;
        ++moves;
        return *this;
    }
};

int main() {
    std::vector<Counted> v;
    for (int i = 0; i < 1000; ++i) v.emplace_back(i);
    Counted::moves = 0;
    v.erase(v.begin());
    std::cout << Counted::moves << "\n";
}
```

## Explanation

A vector's elements are kept next to each other, so removing the first leaves a gap that every
element after it moves down to fill: n − 1 moves, which the program counts as 999. Removing
from the back is O(1). If you need to take from the front often, a std::deque does that in
O(1).
