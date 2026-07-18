"""Roadside Unit: an edge-compute node, not a dumb repeater.

Each RSU aggregates hazard reports and occupancy for the segments touching
its intersection, runs the local congestion predictor, updates the trust
registry based on corroboration, and forwards only a compact digest
upstream -- never raw per-vehicle telemetry.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.ai.congestion_model import CongestionPredictor
from app.network.rsu_network import CloudDigest, RSUNetwork
from app.network.security import issue_certificate
from app.simulation.world import CityGrid

DIGEST_INTERVAL_TICKS = 10


@dataclass
class RSU:
    id: str
    node: str
    grid: CityGrid
    alive: bool = True
    cert_key: str = field(default_factory=issue_certificate)
    predictions: dict[str, dict] = field(default_factory=dict)

    def local_segments(self) -> list:
        return [self.grid.segment_between(self.node, n) for n in self.grid.neighbors(self.node)]

    def run_prediction(self, predictor: CongestionPredictor, tick: int) -> None:
        for seg in self.local_segments():
            self.predictions[seg.id] = predictor.predict(seg, tick)

    def build_digest(self, tick: int, network: RSUNetwork) -> CloudDigest | None:
        if tick % DIGEST_INTERVAL_TICKS != 0:
            return None
        segs = self.local_segments()
        if not segs:
            return None
        avg_occ = sum(s.occupancy for s in segs) / len(segs)
        incidents = sum(1 for s in segs if s.incident)
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
