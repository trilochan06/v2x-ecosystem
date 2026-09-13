"""M4 + M5 - Intelligent RSU edge node.

The deck's key claim about RSUs is that they "transcend mere forwarding".
This one does four jobs:

  M4  aggregates the vehicle messages reaching its cell
  M5  turns those observations into a road-level traffic state
  M6  runs congestion inference locally, on the edge, with no cloud hop
  M7  acts as a federated-learning client -- it trains on what it saw and
      uploads weights, never the observations themselves

The local training samples deserve a note. A supervised congestion model
needs (features now -> occupancy later) pairs, so the RSU parks each
feature vector it computes and only turns it into a training sample once
the horizon has actually elapsed and it can see what really happened. No
labels from the future, no leakage.
"""
from __future__ import annotations

from collections import deque
from dataclasses import dataclass, field

from app.ai.congestion_model import CongestionPredictor
from app.ai.corpus import PREDICTION_HORIZON_TICKS
from app.ai.federated import FederatedClient
from app.network.rsu_network import CloudDigest, RSUNetwork
from app.network.security import issue_certificate
from app.simulation.world import CityGrid

DIGEST_INTERVAL_TICKS = 10
PENDING_SAMPLE_LIMIT = 600


@dataclass
class RSU:
    id: str
    node: str
    grid: CityGrid
    alive: bool = True
    cert_key: str = field(default_factory=issue_certificate)
    predictions: dict[str, dict] = field(default_factory=dict)
    fl_client: FederatedClient | None = None
    messages_handled: int = 0
    _pending: deque = field(default_factory=deque)

    def __post_init__(self) -> None:
        if self.fl_client is None:
            self.fl_client = FederatedClient(self.id)

    def local_segments(self) -> list:
        return [self.grid.segment_between(self.node, n) for n in self.grid.neighbors(self.node)]

    def neighbor_avg_for(self, seg) -> float:
        neighbors = self.grid.adjacent_segments(seg)
        return sum(n.occupancy for n in neighbors) / len(neighbors) if neighbors else seg.occupancy

    # ------------------------------------------------- M6 edge inference
    def run_prediction(
        self, predictor: CongestionPredictor, tick: int, use_federated: bool, explain: bool = True
    ) -> None:
        """Local inference for every segment this RSU covers. With federated
        learning enabled the forecast comes from the collaboratively trained
        global model; otherwise from the centrally trained one."""
        for seg in self.local_segments():
            neighbor_avg = self.neighbor_avg_for(seg)
            result = predictor.predict(seg, tick, neighbor_avg=neighbor_avg, explain=explain)
            if use_federated and self.fl_client is not None and self.fl_client.rounds_joined > 0:
                feats = predictor.build_features(seg, tick, neighbor_avg)
                federated_value = self.fl_client.predict_one(feats)
                result = {
                    **result,
                    "predicted_occupancy": round(federated_value, 3),
                    "model": "federated",
                    "centralized_reference": result["predicted_occupancy"],
                }
            else:
                result = {**result, "model": "centralized"}
            self.predictions[seg.id] = result

    # ------------------------------------------- M7 local training data
    def collect_training_samples(self, predictor: CongestionPredictor, tick: int) -> int:
        """Park this tick's features; harvest the ones whose horizon elapsed."""
        for seg in self.local_segments():
            feats = predictor.build_features(seg, tick, self.neighbor_avg_for(seg))
            self._pending.append((tick + PREDICTION_HORIZON_TICKS, seg.id, feats))
        while len(self._pending) > PENDING_SAMPLE_LIMIT:
            self._pending.popleft()

        harvested = 0
        while self._pending and self._pending[0][0] <= tick:
            _due, seg_id, feats = self._pending.popleft()
            seg = self.grid.segments.get(seg_id)
            if seg is None or self.fl_client is None:
                continue
            self.fl_client.observe(feats, seg.occupancy)
            harvested += 1
        return harvested

    # ------------------------------------------------------ M4 upstream
    def build_digest(self, tick: int, network: RSUNetwork) -> CloudDigest | None:
        if tick % DIGEST_INTERVAL_TICKS != 0:
            return None
        segs = self.local_segments()
        if not segs:
            return None
        digest = CloudDigest(
            tick=tick,
            rsu_id=self.id,
            segment_count=len(segs),
            avg_occupancy=round(sum(s.occupancy for s in segs) / len(segs), 3),
            incident_count=sum(1 for s in segs if s.confirmed_incident),
            vehicles_served=sum(1 for rsu in network.vehicle_cell.values() if rsu == self.id),
        )
        network.record_digest(digest)
        return digest

    def to_state(self) -> dict:
        return {
            "id": self.id,
            "node": self.node,
            "alive": self.alive,
            "predictions": self.predictions,
            "messages_handled": self.messages_handled,
            "fl": {
                "pending_samples": self.fl_client.pending_samples if self.fl_client else 0,
                "rounds_joined": self.fl_client.rounds_joined if self.fl_client else 0,
                "samples_contributed": self.fl_client.samples_contributed if self.fl_client else 0,
                "drift": round(self.fl_client.last_drift, 4) if self.fl_client else 0.0,
            },
        }
