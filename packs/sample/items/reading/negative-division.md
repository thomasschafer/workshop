+++
kind = "reading"
title = "Dividing negative numbers"
skills = ["cpp.semantics"]
prints = "-3 -1"
+++
What does this print?

```cpp
#include <iostream>

int main() {
    int a = -7;
    int b = 2;
    std::cout << a / b << " " << a % b << "\n";
}
```

## Explanation

Since C++11, integer division rounds towards zero, so -7 / 2 is -3 rather than -4. The
remainder takes the sign of the number divided, so that (a / b) * b + a % b is always a: here
-3 × 2 + -1 = -7. Python rounds down instead, giving -4 and 1.
