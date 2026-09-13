"""Feature engineering shared between offline training and live edge inference."""
from __future__ import annotations

import math

FEATURE_NAMES = [
    "lag1",
    "lag2",
    "lag3",
    "time_sin",
    "time_cos",
    "incident_flag",
    "neighbor_avg",
]

DAY_CYCLE_TICKS = 400  # one simulated "day" for the diurnal traffic pattern


def time_features(tick: int) -> tuple[float, float]:
    angle = 2 * math.pi * (tick % DAY_CYCLE_TICKS) / DAY_CYCLE_TICKS
    return math.sin(angle), math.cos(angle)


def build_feature_vector(
    history: list[float],
    tick: int,
    incident: bool,
    neighbor_avg: float = 0.0,
) -> list[float]:
    padded = ([0.0] * 3 + history)[-3:]
    lag1, lag2, lag3 = padded[-1], padded[-2], padded[-3]
    sin_t, cos_t = time_features(tick)
    return [lag1, lag2, lag3, sin_t, cos_t, 1.0 if incident else 0.0, neighbor_avg]
