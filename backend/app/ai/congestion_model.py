"""M6 - Congestion forecasting, centralized flavour.

This is the *cloud* model: it is trained once on the pooled corpus, which
is what a centralized architecture can do precisely because every vehicle
has uploaded its raw telemetry to one place. It therefore doubles as the
Exp 1 baseline the deck asks us to beat (or at least match) with the
federated model in `federated.py`, which never sees pooled data.

Production V2X research forecasts congestion with GNNs / LSTMs /
Transformers over the full road graph. That needs real trajectory data and
GPU training we don't have, so the model here is a gradient-boosted
regressor over engineered spatio-temporal features (occupancy lags,
diurnal phase, live incident flag, neighbouring-segment pressure). The
serving interface is written so a GNN can be swapped in later without
touching a single caller -- see docs/ROADMAP.md.
"""
from __future__ import annotations

import numpy as np
from sklearn.ensemble import GradientBoostingRegressor

from app.ai.corpus import PREDICTION_HORIZON_TICKS, build_dataset
from app.ai.features import FEATURE_NAMES, build_feature_vector


def _generate_training_set() -> tuple[np.ndarray, np.ndarray]:
    return build_dataset(series_count=40, length=400)


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
        self.importances = dict(zip(FEATURE_NAMES, self.model.feature_importances_, strict=True))

    def build_features(self, segment, tick: int, neighbor_avg: float | None = None) -> list[float]:
        """Feature vector for one segment. The incident flag is the
        network's *confirmed* belief, not the physical ground truth -- an
        RSU only gets to use what the V2X layer actually told it."""
        history = segment.history[-3:]
        n_avg = neighbor_avg if neighbor_avg is not None else segment.occupancy
        return build_feature_vector(history, tick, segment.confirmed_incident, n_avg)

    def predict(self, segment, tick: int, neighbor_avg: float | None = None, explain: bool = True) -> dict:
        """`explain=False` skips the occlusion pass (8 model calls instead of
        1). The dashboard wants the explanation; a 300-tick experiment sweep
        does not, and the saving is what keeps the sweep interactive."""
        feats = self.build_features(segment, tick, neighbor_avg)
        if not explain:
            value = float(np.clip(self.model.predict(np.array([feats]))[0], 0.0, 1.0))
            return {
                "segment_id": segment.id,
                "current_occupancy": round(segment.occupancy, 3),
                "predicted_occupancy": round(value, 3),
                "horizon_ticks": PREDICTION_HORIZON_TICKS,
                "risk_level": "high" if value > 0.75 else "moderate" if value > 0.5 else "low",
                "top_factor": "",
                "top_factor_contribution": 0.0,
                "explanation": "",
            }
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
