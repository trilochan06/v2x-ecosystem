"""Procedurally generated traffic corpus.

Both learning paths draw on this:

  * the centralized baseline (`congestion_model.py`) trains on the pooled
    corpus, which is exactly what a cloud-only architecture would do after
    every vehicle uploads its raw telemetry;
  * the federated path (`federated.py`) never sees the pooled corpus -- it
    is used only to build a held-out validation set for scoring the global
    model, an evaluation artefact rather than training data.

Occupancy over time = baseline + diurnal rush-hour curve + noise,
punctuated by hazards that hold occupancy elevated for their duration.
The hazard flag is persistent for the hazard's lifetime, matching how
`Segment.confirmed_incident` behaves at runtime, so the flag the model
trains on means the same thing as the flag it is served at inference.
"""
from __future__ import annotations

import random

import numpy as np

from app.ai.features import build_feature_vector, time_features

PREDICTION_HORIZON_TICKS = 30


def synthetic_series(length: int, seed: int) -> tuple[list[float], list[float]]:
    rng = random.Random(seed)
    base = 0.2 + 0.1 * rng.random()
    series: list[float] = []
    hazard_flags: list[float] = []
    hazard_remaining = 0
    for t in range(length):
        sin_t, _ = time_features(t)
        diurnal = 0.22 * (sin_t + 1) / 2
        noise = rng.gauss(0, 0.02)
        if hazard_remaining <= 0 and rng.random() < 0.009:
            hazard_remaining = rng.randint(20, 55)
        flag = 0.0
        spike = 0.0
        if hazard_remaining > 0:
            flag = 1.0
            spike = 0.4
            hazard_remaining -= 1
        value = max(0.0, min(1.0, base + diurnal + spike + noise))
        series.append(value)
        hazard_flags.append(flag)
    return series, hazard_flags


def build_dataset(
    series_count: int = 40, length: int = 400, seed_offset: int = 0
) -> tuple[np.ndarray, np.ndarray]:
    rng = random.Random(1234 + seed_offset)
    X, y = [], []
    for idx in range(series_count):
        series, hazard_flags = synthetic_series(length, seed=seed_offset + idx)
        for t in range(5, len(series) - PREDICTION_HORIZON_TICKS):
            history = series[max(0, t - 3) : t]
            neighbor_avg = min(1.0, max(0.0, series[t] + rng.gauss(0, 0.05)))
            X.append(build_feature_vector(history, t, bool(hazard_flags[t]), neighbor_avg))
            y.append(series[t + PREDICTION_HORIZON_TICKS])
    return np.array(X), np.array(y)


def validation_set() -> tuple[np.ndarray, np.ndarray]:
    """Held-out series (disjoint seeds from the training corpus) used to
    score the federated global model round over round."""
    return build_dataset(series_count=8, length=300, seed_offset=9000)
