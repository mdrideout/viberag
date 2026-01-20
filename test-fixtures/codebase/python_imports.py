"""
Fixture for refs extraction: multi-line Python imports (parenthesized).
"""

from math import (
    sqrt,
    pow as power,
)
from .local_module import LocalThing


def compute(x: float) -> float:
    return sqrt(x) + power(x, 2)
