"""Edge-deployable congestion forecaster.

Production-grade V2X research prototypes forecast traffic with GNNs /
LSTMs / Transformers over the full road graph. That needs real historic
telemetry and GPU training we don't have in this demo. What we implement
instead is a legitimate, defensible substitute that runs entirely on a
laptop-class "RSU": a gradient-boosted regressor over engineered
spatio-temporal features (recent occupancy lags, diurnal phase, live
incident flag, neighboring-segment pressure), trained on a procedurally
generated synthetic city-traffic corpus. It is swapped for a graph neural
network in the roadmap (see docs/ROADMAP.md) once real trajectory data is
available -- the feature/serving interface below is written so that swap
does not require touching any caller.
"""
from __future__ import annotations

import math
import random

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor

from app.ai.features import FEATURE_NAMES, build_feature_vector, time_features

PREDICTION_HORIZON_TICKS = 30
TRAIN_SAMPLES = 4000


def _synthetic_series(length: int, seed: int) -> tuple[list[float], list[float]]:
    """A segment's occupancy over time = baseline + diurnal rush-hour curve
    + noise, punctuated by incidents that hold occupancy elevated for their
    (persistent, boolean-flagged) duration -- mirroring how `Segment.incident`
    behaves at runtime, so the flag the model is trained on means the same
    thing the flag it is served at inference time means.
    """
    rng = random.Random(seed)
    base = 0.2 + 0.1 * rng.random()
    series: list[float] = []
    incident_flags: list[float] = []
    incident_remaining = 0
    for t in range(length):
        sin_t, _ = time_features(t)
        diurnal = 0.22 * (sin_t + 1) / 2
        noise = rng.gauss(0, 0.02)
        if incident_remaining <= 0 and rng.random() < 0.009:
            incident_remaining = rng.randint(20, 55)
        flag = 0.0
        spike = 0.0
        if incident_remaining > 0:
            flag = 1.0
            spike = 0.4
            incident_remaining -= 1
        value = max(0.0, min(1.0, base + diurnal + spike + noise))
        series.append(value)
        incident_flags.append(flag)
    return series, incident_flags


def _generate_training_set() -> tuple[np.ndarray, np.ndarray]:
    X, y = [], []
    for series_idx in range(40):
        series, incident_flags = _synthetic_series(400, seed=series_idx)
        for t in range(5, len(series) - PREDICTION_HORIZON_TICKS):
            history = series[max(0, t - 3) : t]
            neighbor_avg = series[t] + random.gauss(0, 0.05)
            feats = build_feature_vector(history, t, bool(incident_flags[t]), neighbor_avg)
            target = series[t + PREDICTION_HORIZON_TICKS]
            X.append(feats)
            y.append(target)
    return np.array(X), np.array(y)


class CongestionPredictor:
    """One trained model instance is shared across all RSUs (mirrors how a
    federated-learning round would distribute a single converged model to
    every edge node after aggregating local updates)."""

    def __init__(self):
        X, y = _generate_training_set()
        self.model = GradientBoostingRegressor(
            n_estimators=120, max_depth=3, learning_rate=0.08, random_state=7
        )
        self.model.fit(X, y)
        self.feature_means = X.mean(axis=0)
        self.feature_stds = X.std(axis=0) + 1e-6
        self.importances = dict(zip(FEATURE_NAMES, self.model.feature_importances_))

    def predict(self, segment, tick: int, neighbor_avg: float | None = None) -> dict:
        history = segment.history[-3:]
        n_avg = neighbor_avg if neighbor_avg is not None else segment.occupancy
        feats = build_feature_vector(history, tick, segment.incident, n_avg)
        predicted, contributions = self._predict_with_attribution(feats)

        risk = "low"
        if predicted > 0.75:
            risk = "high"
        elif predicted > 0.5:
            risk = "moderate"

        explanation, top_feature, contribution = self._explain(feats, contributions)

        return {
            "segment_id": segment.id,
            "current_occupancy": round(segment.occupancy, 3),
            "predicted_occupancy": round(predicted, 3),
            "horizon_ticks": PREDICTION_HORIZON_TICKS,
            "risk_level": risk,
            "top_factor": top_feature,
            "top_factor_contribution": round(contribution, 3),
            "explanation": explanation,
        }

    def _predict_with_attribution(self, feats: list[float]) -> tuple[float, np.ndarray]:
        """Local (per-sample) feature attribution via occlusion: for each
        feature, ask "how much would the forecast change if this feature
        were at its dataset-typical value instead?". This is what actually
        drove *this* prediction, unlike a global importance score which is
        the same for every segment regardless of its current state.
        """
        n = len(feats)
        batch = np.tile(np.array(feats), (n + 1, 1))
        for i in range(n):
            batch[i + 1, i] = self.feature_means[i]
        predictions = self.model.predict(batch)
        baseline_pred = float(np.clip(predictions[0], 0.0, 1.0))
        contributions = predictions[0] - predictions[1:]
        return baseline_pred, contributions

    def _explain(self, feats: list[float], contributions: np.ndarray) -> tuple[str, str, float]:
        idx = int(np.argmax(np.abs(contributions)))
        name = FEATURE_NAMES[idx]
        value = feats[idx]
        text_by_feature = {
            "lag1": f"recent occupancy trend ({value:.2f}) is climbing",
            "lag2": f"occupancy two ticks ago ({value:.2f}) shows sustained buildup",
            "lag3": f"a short-term occupancy trend ({value:.2f}) is driving the forecast",
            "time_sin": "diurnal rush-hour phase is the dominant driver",
            "time_cos": "diurnal rush-hour phase is the dominant driver",
            "incident_flag": "an active incident on this segment is the dominant driver",
            "neighbor_avg": f"congestion pressure from neighboring segments ({value:.2f}) is spilling over",
        }
        explanation = text_by_feature[name].capitalize() + "."
        return explanation, name, float(contributions[idx])
