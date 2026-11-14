+++
kind = "reading"
title = "Counting copies"
skills = ["cpp.costs"]
prints = "3"
+++
How many copies of `t` does this make, which is what it prints?

```cpp
#include <iostream>

struct Tracker {
    static inline int copies = 0;
    Tracker() = default;
    Tracker(const Tracker&) { ++copies; }
};

void by_value(Tracker) {}
void by_reference(const Tracker&) {}

int main() {
    Tracker t;
    for (int i = 0; i < 3; ++i) by_value(t);
    for (int i = 0; i < 3; ++i) by_reference(t);
    std::cout << Tracker::copies << "\n";
}
```

## Explanation

Passing by value copies the argument into the parameter, once per call, so the three calls to
by_value make three copies. Passing by const reference makes none. For a type that's expensive
to copy, such as a big vector or string, this is the difference between O(1) and O(size) per
call.
