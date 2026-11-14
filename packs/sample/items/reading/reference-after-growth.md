+++
kind = "reading"
title = "A reference into a growing vector"
skills = ["cpp.memory"]
choices = [
  "Nothing: it prints 1",
  "push_back can move the elements to new memory, so first refers to memory that's been freed",
  "v[0] gives a copy, so first never sees changes to v",
  "It doesn't compile, as a reference to a vector's element can't be taken",
]
answer = 2

[check]
expect = "sanitizer-error"
+++
What's wrong with this code?

```cpp
#include <iostream>
#include <vector>

int main() {
    std::vector<int> v = {1, 2, 3};
    int& first = v[0];
    v.push_back(4);
    std::cout << first << "\n";
}
```

## Explanation

A vector keeps its elements in one block of memory. When it's full, push_back allocates a
bigger block, moves the elements across and frees the old one, which leaves any reference,
pointer or iterator into the old block dangling. Reading through first is then undefined
behaviour: it may well print 1, which is what makes this kind of bug hard to find. Keep an
index instead, or reserve the space first.
