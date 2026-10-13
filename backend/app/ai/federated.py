"""Federated congestion learning across the roadside units.

Until now a single gradient-boosted model was fitted once on a synthetic
corpus and handed to every RSU, with a comment observing that this is what
a federated round "would" produce. That is a centralised model wearing a
federated label. This module makes the federation real: each RSU trains a
local model on observations it actually received, uploads *parameters*, and
never uploads a sample.

The aggregation rule is where this differs from textbook FedAvg. Plain
FedAvg weights each node by how many local examples it holds, which is
correct where clients hold samples of one distribution and more samples
simply mean more evidence. A roadside unit is not that kind of client: its
examples come from reports made by vehicles the network may already have
reason to disbelieve. Weighting purely by volume therefore hands the
loudest voice to whichever compromised unit happens to sit on the busiest
road.

So each unit is weighted by the corroboration-derived trust of its own data
sources. That signal is not invented here -- the trust registry already
maintains it for hazard validation -- so carrying it into aggregation costs
one extra weighted mean per round and nothing on the air.

A plain-FedAvg shadow model is aggregated from the same uploads every round
and scored on the same held-out data, so the benefit of the trust weighting
is measured rather than asserted.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

from app.ai.features import FEATURE_NAMES

FEATURE_DIM = len(FEATURE_NAMES)
ROUND_INTERVAL_TICKS = 15
MIN_SAMPLES_PER_ROUND = 12
LOCAL_EPOCHS = 12
LEARNING_RATE = 0.3
BUFFER_LIMIT = 400
# A unit whose data came from sources this untrusted does not get a vote.
PARTICIPATION_TRUST_FLOOR = 0.5
# Bytes a single raw observation would have occupied had it been uploaded:
# the feature vector plus its label, four bytes each, plus record overhead.
RAW_SAMPLE_BYTES = (FEATURE_DIM + 1) * 4 + 24
FLOAT_BYTES = 4
HISTORY_LIMIT = 60


@dataclass
class Sample:
    x: list[float]
    y: float
    trust: float


@dataclass
class Weights:
    w: list[float] = field(default_factory=lambda: [0.0] * FEATURE_DIM)
    b: float = 0.0

    def copy(self) -> "Weights":
        return Weights(w=list(self.w), b=self.b)

    def predict(self, x: list[float]) -> float:
        return sum(wi * xi for wi, xi in zip(self.w, x)) + self.b

    def distance_to(self, other: "Weights") -> float:
        sq = sum((a - b) ** 2 for a, b in zip(self.w, other.w))
        return math.sqrt(sq) + abs(self.b - other.b)


def _clamp01(v: float) -> float:
    return max(0.0, min(1.0, v))


@dataclass
class FederatedClient:
    """One roadside unit's share of the learning problem."""

    rsu_id: str
    weights: Weights = field(default_factory=Weights)
    buffer: list[Sample] = field(default_factory=list)
    data_trust: float = 1.0
    rounds_joined: int = 0
    samples_contributed: int = 0
    last_drift: float = 0.0

    def observe(self, x: list[float], y: float, source_trust: float = 1.0) -> None:
        """Record one local observation. It stays here; only parameters leave.

        `source_trust` travels with the sample so that aggregation can later
        discount a unit whose view of the road was assembled from reports
        nobody corroborated.
        """
        self.buffer.append(Sample(x=list(x), y=y, trust=source_trust))
        if len(self.buffer) > BUFFER_LIMIT:
            self.buffer.pop(0)
        self.data_trust = sum(s.trust for s in self.buffer) / len(self.buffer)

    def local_train(self) -> tuple[Weights, int, float] | None:
        """One local round. Returns (weights, sample count, data trust)."""
        n = len(self.buffer)
        if n < MIN_SAMPLES_PER_ROUND:
            return None

        w = list(self.weights.w)
        b = self.weights.b
        trust_sum = sum(s.trust for s in self.buffer)
        trust_mean = trust_sum / n if trust_sum > 0 else 1.0

        for _ in range(LOCAL_EPOCHS):
            grad = [0.0] * FEATURE_DIM
            grad_b = 0.0
            for s in self.buffer:
                # A fabricated road state still enters the buffer -- the unit
                # cannot tell at receipt -- but it pulls the local model far
                # less than a corroborated one.
                scale = (s.trust / trust_mean) if trust_sum > 0 else 1.0
                err = (sum(wi * xi for wi, xi in zip(w, s.x)) + b - s.y) * scale
                for i in range(FEATURE_DIM):
                    grad[i] += err * s.x[i]
                grad_b += err
            for i in range(FEATURE_DIM):
                w[i] -= LEARNING_RATE * grad[i] / n
            b -= LEARNING_RATE * grad_b / n

        self.weights = Weights(w=w, b=b)
        self.rounds_joined += 1
        self.samples_contributed += n
        return self.weights.copy(), n, self.data_trust

    def adopt(self, globals_: Weights) -> None:
        """Take the aggregated model, recording first how far local training
        had pulled away from it -- the mobility-induced divergence the
        federated literature warns about."""
        self.last_drift = self.weights.distance_to(globals_)
        self.weights = globals_.copy()
        self.buffer.clear()


@dataclass
class RoundSummary:
    round: int
    tick: int
    participants: list[str]
    excluded: list[str]
    samples_used: int
    global_loss: float
    plain_loss: float
    loss_delta: float
    mean_client_trust: float
    avg_client_drift: float
    weights_bytes: int
    raw_bytes_avoided: int


@dataclass
class FederatedCoordinator:
    """Runs the rounds and keeps the plain-FedAvg shadow for comparison."""

    clients: dict[str, FederatedClient] = field(default_factory=dict)
    global_weights: Weights = field(default_factory=Weights)
    shadow_weights: Weights = field(default_factory=Weights)
    holdout: list[Sample] = field(default_factory=list)
    rounds: list[RoundSummary] = field(default_factory=list)
    initial_loss: float | None = None
    last_loss: float = 0.0

    def client(self, rsu_id: str) -> FederatedClient:
        if rsu_id not in self.clients:
            self.clients[rsu_id] = FederatedClient(rsu_id=rsu_id)
        return self.clients[rsu_id]

    def add_holdout(self, x: list[float], y: float) -> None:
        self.holdout.append(Sample(x=list(x), y=y, trust=1.0))
        if len(self.holdout) > 300:
            self.holdout.pop(0)

    def should_run(self, tick: int) -> bool:
        return tick > 0 and tick % ROUND_INTERVAL_TICKS == 0

    def _loss(self, weights: Weights) -> float:
        if not self.holdout:
            return 0.0
        total = 0.0
        for s in self.holdout:
            err = _clamp01(weights.predict(s.x)) - s.y
            total += err * err
        return total / len(self.holdout)

    def baseline_loss(self) -> float:
        """What predicting the holdout's own mean would score.

        Raw loss alone is not interpretable here: the holdout is a sliding
        window over a city that starts empty and fills up, so the variance of
        the target grows during a run and the raw figure rises even when the
        model is improving. Skill against this baseline is stable under that
        drift, so it is what the dashboard reports.
        """
        if not self.holdout:
            return 0.0
        mean_y = sum(s.y for s in self.holdout) / len(self.holdout)
        return sum((s.y - mean_y) ** 2 for s in self.holdout) / len(self.holdout)

    def skill(self, loss: float | None = None) -> float:
        base = self.baseline_loss()
        if base <= 0:
            return 0.0
        value = self.last_loss if loss is None else loss
        return 1.0 - value / base

    def run_round(self, tick: int) -> RoundSummary | None:
        uploads: list[tuple[str, Weights, int, float]] = []
        for rsu_id, client in self.clients.items():
            result = client.local_train()
            if result is None:
                continue
            weights, n, trust = result
            uploads.append((rsu_id, weights, n, trust))

        if not uploads:
            return None

        eligible = [u for u in uploads if u[3] >= PARTICIPATION_TRUST_FLOOR]
        excluded = [u[0] for u in uploads if u[3] < PARTICIPATION_TRUST_FLOOR]
        if not eligible:
            # Every unit below the floor is a network-wide anomaly, not a
            # reason to stop learning. Fall back to plain averaging and say
            # so, rather than producing an empty aggregate.
            eligible = uploads
            excluded = []

        self.global_weights = self._aggregate(eligible, trust_weighted=True)
        self.shadow_weights = self._aggregate(uploads, trust_weighted=False)

        loss = self._loss(self.global_weights)
        plain = self._loss(self.shadow_weights)
        if self.initial_loss is None:
            self.initial_loss = loss
        delta = loss - self.last_loss
        self.last_loss = loss

        drifts = []
        for rsu_id, _w, _n, _t in eligible:
            client = self.clients[rsu_id]
            client.adopt(self.global_weights)
            drifts.append(client.last_drift)
        for rsu_id in excluded:
            self.clients[rsu_id].buffer.clear()

        samples = sum(n for _i, _w, n, _t in eligible)
        summary = RoundSummary(
            round=len(self.rounds) + 1,
            tick=tick,
            participants=[u[0] for u in eligible],
            excluded=excluded,
            samples_used=samples,
            global_loss=round(loss, 6),
            plain_loss=round(plain, 6),
            loss_delta=round(delta, 6),
            mean_client_trust=round(
                sum(t for _i, _w, _n, t in eligible) / len(eligible), 4
            ),
            avg_client_drift=round(sum(drifts) / len(drifts), 4) if drifts else 0.0,
            # Both directions: upload and the push of the aggregate back down.
            weights_bytes=(FEATURE_DIM + 1) * FLOAT_BYTES * len(eligible) * 2,
            raw_bytes_avoided=samples * RAW_SAMPLE_BYTES,
        )
        self.rounds.append(summary)
        if len(self.rounds) > HISTORY_LIMIT:
            self.rounds.pop(0)
        return summary

    @staticmethod
    def _aggregate(
        uploads: list[tuple[str, Weights, int, float]], trust_weighted: bool
    ) -> Weights:
        total = 0.0
        for _i, _w, n, trust in uploads:
            total += n * trust if trust_weighted else n
        if total <= 0:
            return Weights()

        w = [0.0] * FEATURE_DIM
        b = 0.0
        for _i, weights, n, trust in uploads:
            share = (n * trust if trust_weighted else n) / total
            for i in range(FEATURE_DIM):
                w[i] += weights.w[i] * share
            b += weights.b * share
        return Weights(w=w, b=b)

    def predict(self, x: list[float]) -> float:
        return _clamp01(self.global_weights.predict(x))

    def to_state(self) -> dict:
        latest = self.rounds[-1] if self.rounds else None
        reduction = 0.0
        if self.initial_loss:
            reduction = round((1 - self.last_loss / self.initial_loss) * 100, 2)
        plain = self._loss(self.shadow_weights)
        return {
            "baseline_loss": round(self.baseline_loss(), 6),
            "skill": round(self.skill(), 4),
            "plain_skill": round(self.skill(plain), 4),
            "rounds_completed": len(self.rounds),
            "round_interval": ROUND_INTERVAL_TICKS,
            "clients": [
                {
                    "rsu_id": c.rsu_id,
                    "buffered_samples": len(c.buffer),
                    "data_trust": round(c.data_trust, 3),
                    "rounds_joined": c.rounds_joined,
                    "samples_contributed": c.samples_contributed,
                    "drift": round(c.last_drift, 4),
                    "eligible": c.data_trust >= PARTICIPATION_TRUST_FLOOR,
                }
                for c in self.clients.values()
            ],
            "participation_floor": PARTICIPATION_TRUST_FLOOR,
            "initial_loss": round(self.initial_loss, 6) if self.initial_loss else 0.0,
            "current_loss": round(self.last_loss, 6),
            "loss_reduction_pct": reduction,
            "plain_fedavg_loss": round(plain, 6),
            "latest_round": latest.__dict__ if latest else None,
            "history": [r.__dict__ for r in self.rounds[-40:]],
            "total_raw_bytes_avoided": sum(r.raw_bytes_avoided for r in self.rounds),
            "total_weights_bytes": sum(r.weights_bytes for r in self.rounds),
            "holdout_size": len(self.holdout),
        }
