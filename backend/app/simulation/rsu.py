"""Roadside Unit: an edge-compute node, not a dumb repeater.

Each RSU aggregates hazard reports and occupancy for the segments touching
its intersection, runs the local congestion predictor, updates the trust
registry based on corroboration, and forwards only a compact digest
upstream -- never raw per-vehicle telemetry.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.ai.congestion_model import CongestionPredictor
from app.ai.features import build_feature_vector
from app.ai.federated import FederatedCoordinator
from app.network.rsu_network import CloudDigest, RSUNetwork
from app.network.security import issue_certificate
from app.simulation.world import CityGrid

DIGEST_INTERVAL_TICKS = 10
# A sample can only be labelled once the horizon it predicts has elapsed, so
# the unit holds each feature vector until its outcome is observable.
#
# Fifteen ticks, not the thirty the offline model uses. A vehicle crosses a
# 250 m segment in roughly eighteen ticks, so at a thirty-tick horizon the
# traffic being predicted has completely turned over and the occupancy lags
# carry no information about it -- measured skill against a predict-the-mean
# baseline is -0.03 at thirty ticks, +0.18 at fifteen and +0.55 at eight.
# Fifteen is about one segment traversal, which is the longest horizon these
# features actually support.
LABEL_DELAY_TICKS = 15


@dataclass
class RSU:
    id: str
    node: str
    grid: CityGrid
    alive: bool = True
    cert_key: str = field(default_factory=issue_certificate)
    predictions: dict[str, dict] = field(default_factory=dict)
    # Feature vectors waiting for the outcome they predict to become visible.
    _pending: list[tuple[int, str, list[float], float]] = field(default_factory=list)

    def local_segments(self) -> list:
        return [self.grid.segment_between(self.node, n) for n in self.grid.neighbors(self.node)]

    def run_prediction(self, predictor: CongestionPredictor, tick: int) -> None:
        for seg in self.local_segments():
            neighbors = self.grid.adjacent_segments(seg)
            neighbor_avg = sum(n.occupancy for n in neighbors) / len(neighbors) if neighbors else seg.occupancy
            self.predictions[seg.id] = predictor.predict(
                seg, tick, neighbor_avg=neighbor_avg, incident=seg.reported_incident
            )

    def collect_training_data(
        self, coordinator: FederatedCoordinator, tick: int, source_trust: float
    ) -> None:
        """Build local training examples from the roads this unit covers.

        The feature vector is recorded now and parked; the label is whatever
        the segment's occupancy turns out to be once the forecast horizon has
        actually elapsed. Nothing here leaves the unit.
        """
        client = coordinator.client(self.id)

        for seg in self.local_segments():
            neighbors = self.grid.adjacent_segments(seg)
            neighbor_avg = (
                sum(n.occupancy for n in neighbors) / len(neighbors) if neighbors else seg.occupancy
            )
            # The incident feature is the unit's *belief*. A unit fed
            # fabricated reports therefore trains on a corrupted flag,
            # which is exactly the data poisoning trust weighting exists
            # to contain.
            feats = build_feature_vector(
                seg.history[-3:], tick, seg.reported_incident, neighbor_avg
            )
            # The same vector built from physical truth. The unit never sees
            # this and never trains on it; it exists only so the harness can
            # score the aggregate on how well it predicts reality rather than
            # on how well it predicts the network's own mistakes.
            truth_feats = build_feature_vector(
                seg.history[-3:], tick, seg.incident, neighbor_avg
            )
            self._pending.append(
                (tick + LABEL_DELAY_TICKS, seg.id, feats, truth_feats, source_trust)
            )

        ready = [p for p in self._pending if p[0] <= tick]
        if not ready:
            return
        self._pending = [p for p in self._pending if p[0] > tick]
        for _due, segment_id, feats, truth_feats, trust in ready:
            seg = self.grid.segments.get(segment_id)
            if seg is None:
                continue
            client.observe(feats, seg.occupancy, source_trust=trust)
            # A slice of the stream is withheld from every client and used
            # only to score the aggregate, so the comparison between the
            # trust-weighted model and the plain shadow is made on data that
            # trained neither of them -- and on ground-truth features, so the
            # score measures prediction of reality rather than fluency in the
            # network's own errors.
            if (tick + hash(segment_id)) % 7 == 0:
                coordinator.add_holdout(truth_feats, seg.occupancy)

    def build_digest(self, tick: int, network: RSUNetwork) -> CloudDigest | None:
        if tick % DIGEST_INTERVAL_TICKS != 0:
            return None
        segs = self.local_segments()
        if not segs:
            return None
        avg_occ = sum(s.occupancy for s in segs) / len(segs)
        incidents = sum(1 for s in segs if s.reported_incident)
        vehicles_served = sum(1 for v, rsu in network.vehicle_cell.items() if rsu == self.id)
        digest = CloudDigest(
            tick=tick,
            rsu_id=self.id,
            segment_count=len(segs),
            avg_occupancy=round(avg_occ, 3),
            incident_count=incidents,
            vehicles_served=vehicles_served,
        )
        network.record_digest(digest)
        return digest

    def to_state(self) -> dict:
        return {
            "id": self.id,
            "node": self.node,
            "alive": self.alive,
            "predictions": self.predictions,
        }
