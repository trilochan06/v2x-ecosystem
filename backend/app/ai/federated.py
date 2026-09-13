"""M7 - Federated Learning across the RSU fleet.

The deck's core privacy claim is that raw vehicular telemetry never has to
leave the edge: RSUs train locally and exchange *model weights only*, which
a regional aggregator averages (FedAvg) into a global model that is pushed
back out.

This module implements that literally:

  * `FederatedClient` lives on one RSU. It accumulates feature/target pairs
    from the vehicles in its own cell and trains a linear regressor on them
    by SGD. Its sample buffer never leaves the object.
  * `FederatedCoordinator` runs a round: it takes each participating
    client's weight vector plus a sample count -- and nothing else -- and
    produces the sample-weighted average, the standard FedAvg update.

Why a linear model rather than a deep net: FedAvg on a linear model is
*exactly* the average of the clients' parameters, so the aggregation step
is verifiable by hand in a viva, and the whole thing trains on a laptop CPU
in milliseconds. The interface (`predict`) matches the centralized
`CongestionPredictor`, so the two can be compared head to head, which is
what Exp 1 vs Exp 3 in the deck asks for.

Two effects the literature flags (see deck slide 8, "struggles with
convergence in highly mobile nodes") are measured rather than hidden:
per-client drift from the global model, and the bandwidth actually spent on
weights versus what shipping the raw samples would have cost.
"""
from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np

from app.ai.corpus import validation_set
from app.ai.features import FEATURE_NAMES

FEATURE_DIM = len(FEATURE_NAMES)
FLOAT_BYTES = 4  # float32 on the wire
# One raw telemetry sample = 7 features + 1 target, plus a ~24 byte header
# (pseudonym, timestamp, segment id) -- what a cloud-only design uploads.
RAW_SAMPLE_BYTES = (FEATURE_DIM + 1) * FLOAT_BYTES + 24

LOCAL_EPOCHS = 4
LEARNING_RATE = 0.03
MIN_SAMPLES_PER_ROUND = 12
BUFFER_LIMIT = 400


@dataclass
class ModelWeights:
    w: np.ndarray
    b: float

    @staticmethod
    def zeros() -> ModelWeights:
        return ModelWeights(w=np.zeros(FEATURE_DIM), b=0.0)

    def copy(self) -> ModelWeights:
        return ModelWeights(w=self.w.copy(), b=float(self.b))

    def predict(self, X: np.ndarray) -> np.ndarray:
        return X @ self.w + self.b

    @property
    def payload_bytes(self) -> int:
        """What one client actually uploads per round."""
        return (FEATURE_DIM + 1) * FLOAT_BYTES

    def distance_to(self, other: ModelWeights) -> float:
        return float(np.linalg.norm(self.w - other.w) + abs(self.b - other.b))


@dataclass
class RoundSummary:
    round_number: int
    tick: int
    participants: list[str]
    samples_used: int
    global_loss: float
    loss_delta: float
    weights_kilobytes: float
    raw_kilobytes_avoided: float
    avg_client_drift: float
    #: What unweighted FedAvg would have produced this round, so the benefit
    #: of trust weighting is measured rather than claimed.
    plain_fedavg_loss: float = 0.0
    mean_client_trust: float = 1.0
    excluded_clients: list[str] = field(default_factory=list)

    def as_dict(self) -> dict:
        return {
            "round": self.round_number,
            "tick": self.tick,
            "participants": self.participants,
            "client_count": len(self.participants),
            "samples_used": self.samples_used,
            "global_loss": round(self.global_loss, 6),
            "loss_delta": round(self.loss_delta, 6),
            "weights_kilobytes": round(self.weights_kilobytes, 4),
            "raw_kilobytes_avoided": round(self.raw_kilobytes_avoided, 2),
            "avg_client_drift": round(self.avg_client_drift, 4),
            "plain_fedavg_loss": round(self.plain_fedavg_loss, 6),
            "mean_client_trust": round(self.mean_client_trust, 4),
            "excluded_clients": list(self.excluded_clients),
        }


#: A client whose data came from vehicles this far below full trust is kept
#: out of the round entirely. Set well above the quarantine threshold: by the
#: time corroboration has pushed a source this low, its road state is not
#: worth averaging in at any weight.
TRUST_EXCLUSION_FLOOR = 0.5


class FederatedClient:
    """The on-RSU half of federated learning."""

    def __init__(self, rsu_id: str):
        self.rsu_id = rsu_id
        self.weights = ModelWeights.zeros()
        self._buffer: list[tuple[np.ndarray, float, float]] = []
        self.samples_contributed = 0
        self.rounds_joined = 0
        self.last_drift = 0.0
        #: Mean trust of the vehicles whose reports produced this client's
        #: current buffer. 1.0 until anything suspect arrives.
        self.data_trust = 1.0

    # -- local data stays here, permanently ------------------------------
    def observe(self, features: list[float], target: float, source_trust: float = 1.0) -> None:
        """Buffer one local observation.

        `source_trust` is how much the corroboration layer believes the
        vehicles that produced this road state. It travels with the sample so
        aggregation can discount a client whose view of the road was built
        from reports nobody else could confirm.
        """
        self._buffer.append((np.array(features, dtype=float), float(target), float(source_trust)))
        if len(self._buffer) > BUFFER_LIMIT:
            self._buffer.pop(0)
        self.data_trust = float(np.mean([t for _, _, t in self._buffer]))

    @property
    def pending_samples(self) -> int:
        return len(self._buffer)

    def local_train(self) -> tuple[ModelWeights, int, float] | None:
        """Run local SGD epochs. Returns (weights, sample_count, data_trust)
        to upload, or None when this client hasn't seen enough traffic."""
        if len(self._buffer) < MIN_SAMPLES_PER_ROUND:
            return None

        X = np.array([x for x, _, _ in self._buffer])
        y = np.array([t for _, t, _ in self._buffer])
        # Believe each sample in proportion to its source. A fabricated road
        # state still enters the buffer -- the RSU cannot tell at receipt --
        # but it pulls the local model far less than a corroborated one.
        sample_w = np.array([t for _, _, t in self._buffer])
        if sample_w.sum() <= 0:
            sample_w = np.ones_like(sample_w)
        sample_w = sample_w / sample_w.mean()
        w, b = self.weights.w.copy(), float(self.weights.b)

        n = len(y)
        for _ in range(LOCAL_EPOCHS):
            preds = X @ w + b
            error = (preds - y) * sample_w
            w -= LEARNING_RATE * (X.T @ error) / n
            b -= LEARNING_RATE * float(error.mean())

        self.weights = ModelWeights(w=w, b=b)
        self.samples_contributed += n
        self.rounds_joined += 1
        return self.weights.copy(), n, self.data_trust

    def load_global(self, global_weights: ModelWeights) -> None:
        """Adopt the aggregated model; record how far local training had
        drifted from it first (the mobility-induced divergence the
        literature warns about)."""
        self.last_drift = self.weights.distance_to(global_weights)
        self.weights = global_weights.copy()
        self._buffer.clear()

    def predict_one(self, features: list[float]) -> float:
        x = np.array(features, dtype=float)
        return float(np.clip(self.weights.predict(x.reshape(1, -1))[0], 0.0, 1.0))


class FederatedCoordinator:
    """L4 - regional aggregation. Sees weights and sample counts. Never
    sees a single raw observation."""

    def __init__(self):
        self.global_weights = ModelWeights.zeros()
        #: Shadow model aggregated by plain FedAvg, for comparison only.
        self._plain_weights = ModelWeights.zeros()
        self.rounds: list[RoundSummary] = []
        self._X_val, self._y_val = validation_set()
        self._last_loss = self._loss(self.global_weights)
        self.initial_loss = self._last_loss

    def _loss(self, weights: ModelWeights) -> float:
        preds = np.clip(weights.predict(self._X_val), 0.0, 1.0)
        return float(np.mean((preds - self._y_val) ** 2))

    @staticmethod
    def _average(uploads: list[tuple[str, ModelWeights, float]]) -> ModelWeights:
        """Weighted mean of client parameters. Weights must be positive."""
        total = sum(weight for _, _, weight in uploads)
        agg_w = np.zeros(FEATURE_DIM)
        agg_b = 0.0
        for _, weights, weight in uploads:
            share = weight / total
            agg_w += weights.w * share
            agg_b += weights.b * share
        return ModelWeights(w=agg_w, b=agg_b)

    def run_round(self, clients: list[FederatedClient], tick: int) -> RoundSummary | None:
        uploads: list[tuple[str, ModelWeights, int, float]] = []
        for client in clients:
            trained = client.local_train()
            if trained is None:
                continue
            weights, n, trust = trained
            uploads.append((client.rsu_id, weights, n, trust))

        if not uploads:
            return None

        total_samples = sum(n for _, _, n, _ in uploads)

        # --- Trust-weighted aggregation --------------------------------------
        # Plain FedAvg weights a client purely by how much data it has, which
        # is exactly the wrong instinct when some of that data came from
        # vehicles the network does not believe: the busiest compromised RSU
        # gets the loudest vote. Here the sample count is scaled by the
        # corroboration-derived trust of the vehicles that produced the road
        # state, and a client below the floor is excluded from the round
        # outright rather than merely quietened.
        excluded = [rsu_id for rsu_id, _, _, t in uploads if t < TRUST_EXCLUSION_FLOOR]
        admitted = [
            (rsu_id, weights, n * t)
            for rsu_id, weights, n, t in uploads
            if t >= TRUST_EXCLUSION_FLOOR
        ]
        # Every client being distrusted at once is a network-wide anomaly, not
        # a reason to skip the round; fall back to plain FedAvg and say so.
        if not admitted:
            admitted = [(rsu_id, weights, float(n)) for rsu_id, weights, n, _ in uploads]
            excluded = []

        self.global_weights = self._average(admitted)

        # --- The shadow model: what plain FedAvg would have produced ---------
        # Kept so the benefit is measured rather than asserted. It costs one
        # extra weighted mean per round and nothing on the wire.
        self._plain_weights = self._average(
            [(rsu_id, weights, float(n)) for rsu_id, weights, n, _ in uploads]
        )

        drifts = []
        admitted_ids = {rsu_id for rsu_id, _, _ in admitted}
        for client in clients:
            if client.rsu_id in admitted_ids:
                client.load_global(self.global_weights)
                drifts.append(client.last_drift)

        loss = self._loss(self.global_weights)
        plain_loss = self._loss(self._plain_weights)
        weights_bytes = self.global_weights.payload_bytes * len(uploads) * 2  # up + down
        summary = RoundSummary(
            round_number=len(self.rounds) + 1,
            tick=tick,
            participants=[rsu_id for rsu_id, _, _, _ in uploads],
            samples_used=total_samples,
            global_loss=loss,
            loss_delta=loss - self._last_loss,
            weights_kilobytes=weights_bytes / 1024,
            raw_kilobytes_avoided=(total_samples * RAW_SAMPLE_BYTES) / 1024,
            avg_client_drift=float(np.mean(drifts)) if drifts else 0.0,
            plain_fedavg_loss=plain_loss,
            mean_client_trust=float(np.mean([t for _, _, _, t in uploads])),
            excluded_clients=excluded,
        )
        self._last_loss = loss
        self.rounds.append(summary)
        if len(self.rounds) > 200:
            self.rounds.pop(0)
        return summary

    # --------------------------------------------------------------- views
    def convergence_round(self, target_fraction: float = 0.25) -> int | None:
        """First round whose loss fell to `target_fraction` of the starting
        loss -- the deck's "convergence rate" metric."""
        if self.initial_loss <= 0:
            return None
        target = self.initial_loss * target_fraction
        for r in self.rounds:
            if r.global_loss <= target:
                return r.round_number
        return None

    def snapshot(self) -> dict:
        latest = self.rounds[-1] if self.rounds else None
        return {
            "rounds_completed": len(self.rounds),
            "initial_loss": round(self.initial_loss, 6),
            "current_loss": round(self._last_loss, 6),
            "loss_reduction_pct": round(
                100 * (1 - self._last_loss / self.initial_loss) if self.initial_loss else 0.0, 2
            ),
            "convergence_round": self.convergence_round(),
            "total_weights_kilobytes": round(sum(r.weights_kilobytes for r in self.rounds), 3),
            "total_raw_kilobytes_avoided": round(sum(r.raw_kilobytes_avoided for r in self.rounds), 1),
            "latest_round": latest.as_dict() if latest else None,
            # The trust-weighting comparison, kept alongside the headline so
            # the defence is shown working rather than asserted.
            "plain_fedavg_loss": round(self._loss(self._plain_weights), 6),
            "trust_weighting_gain_pct": round(
                100 * (1 - self._last_loss / self._loss(self._plain_weights))
                if self._loss(self._plain_weights)
                else 0.0,
                2,
            ),
            "mean_client_trust": round(latest.mean_client_trust, 4) if latest else 1.0,
            "excluded_clients": list(latest.excluded_clients) if latest else [],
            "rounds_with_exclusions": sum(1 for r in self.rounds if r.excluded_clients),
            "history": [r.as_dict() for r in self.rounds[-60:]],
            "weights": {
                "features": FEATURE_NAMES,
                "coefficients": [round(float(v), 4) for v in self.global_weights.w],
                "intercept": round(float(self.global_weights.b), 4),
            },
        }
