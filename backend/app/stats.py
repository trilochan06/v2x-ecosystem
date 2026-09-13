"""Small-sample summary statistics for the experiment harness.

A single seed is one sample of a stochastic process, and this simulation is
stochastic everywhere: where hazards appear, which frames survive the channel,
which vehicles witness what. Quoting one seed's number as "the result" is the
most common way a simulation study overstates its findings.

So every reported figure is a mean over several seeds with a 95% confidence
interval attached. The interval uses Student's t, not 1.96 sigma, because at
n = 3 or n = 5 the normal approximation is badly optimistic -- t(df=2) is
4.303, more than twice the normal multiplier.

No scipy: the harness ships a t-table rather than a dependency it would use
once.
"""
from __future__ import annotations

import math
from dataclasses import dataclass

#: Two-tailed t critical values at 95%, indexed by degrees of freedom.
_T95: dict[int, float] = {
    1: 12.706,
    2: 4.303,
    3: 3.182,
    4: 2.776,
    5: 2.571,
    6: 2.447,
    7: 2.365,
    8: 2.306,
    9: 2.262,
    10: 2.228,
    11: 2.201,
    12: 2.179,
    13: 2.160,
    14: 2.145,
    15: 2.131,
    16: 2.120,
    17: 2.110,
    18: 2.101,
    19: 2.093,
    20: 2.086,
    25: 2.060,
    30: 2.042,
    40: 2.021,
    60: 2.000,
}
#: The normal limit, used once the t-table runs out.
_T95_INFINITY = 1.960


def t_multiplier(df: int) -> float:
    """Two-tailed 95% t critical value for `df` degrees of freedom."""
    if df < 1:
        return 0.0
    if df in _T95:
        return _T95[df]
    largest = max(_T95)
    if df > largest:
        # Past the table, t is within a percent of the normal limit.
        return _T95_INFINITY
    # Between tabulated points, take the nearest df *below*, whose multiplier
    # is the larger one -- so the interval is never understated.
    return _T95[max(k for k in _T95 if k < df)]


@dataclass(frozen=True)
class Estimate:
    """A mean with the uncertainty that belongs to it."""

    mean: float
    half_width: float
    stdev: float
    n: int

    @property
    def low(self) -> float:
        return self.mean - self.half_width

    @property
    def high(self) -> float:
        return self.mean + self.half_width

    @property
    def reportable(self) -> bool:
        """One sample has no interval, so it is a number, not a result."""
        return self.n >= 2

    def as_dict(self) -> dict:
        return {
            "mean": round(self.mean, 4),
            "half_width": round(self.half_width, 4),
            "low": round(self.low, 4),
            "high": round(self.high, 4),
            "stdev": round(self.stdev, 4),
            "n": self.n,
            "reportable": self.reportable,
        }


def summarize(values: list[float]) -> Estimate:
    """Mean and 95% confidence half-width over `values`."""
    n = len(values)
    if n == 0:
        return Estimate(mean=0.0, half_width=0.0, stdev=0.0, n=0)
    mean = sum(values) / n
    if n == 1:
        return Estimate(mean=mean, half_width=0.0, stdev=0.0, n=1)
    variance = sum((v - mean) ** 2 for v in values) / (n - 1)
    stdev = math.sqrt(variance)
    half_width = t_multiplier(n - 1) * stdev / math.sqrt(n)
    return Estimate(mean=mean, half_width=half_width, stdev=stdev, n=n)


def separated(a: Estimate, b: Estimate) -> bool:
    """True when two 95% intervals do not overlap.

    Non-overlapping intervals are sufficient evidence of a difference but not
    necessary for one, so this is used to decide when the site may claim a
    result -- never to deny one.
    """
    if not (a.reportable and b.reportable):
        return False
    return a.high < b.low or b.high < a.low
