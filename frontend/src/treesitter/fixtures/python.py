"""Representative Python module for syntax highlighting parity with Helix."""

# TODO(alice): cover common Python constructs and injections (#42)
# FIXME: verify https://example.com/docs and @bob mentions
from __future__ import annotations

import asyncio
import re
from dataclasses import dataclass
from typing import Generic, TypeVar

T = TypeVar("T")

PATTERN = re.compile(r"^(?P<key>[a-z_]+)=(?P<val>\d+)$")
PI: float = 3.14159


@dataclass(frozen=True)
class Point(Generic[T]):
    x: T
    y: T

    def describe(self, label: str = "pt") -> str:
        return f"{label}({self.x}, {self.y})"


def evaluate(values: list[int], scale: float = 1.0) -> int:
    total = 0
    for idx, val in enumerate(values):
        if val < 0:
            raise ValueError(f"negative at {idx}: {val}")
        elif val % 2 == 0:
            total += int(val * scale)
        else:
            total += (lambda n: n * 2 + 1)(val)
    match total:
        case 0:
            return 0
        case n if n > 100:
            return n - 42
        case _:
            return total


async def run_all(items: list[str]) -> dict[str, int]:
    await asyncio.sleep(0)
    parsed: dict[str, int] = {}
    for line in items:
        m = PATTERN.match(line)
        if m is not None:
            parsed[m.group("key")] = int(m.group("val"))
    return parsed


if __name__ == "__main__":
    pts = [Point(1, 2), Point(3, 4)]
    flag = not False and (True or None is None)
    print(evaluate([1, 2, 3]), pts[0].describe(), flag)
