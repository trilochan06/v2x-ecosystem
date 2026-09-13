"""Fog computing tier: sits between individual RSUs (edge) and the national
cloud. A single RSU can only see its own intersection; it can't tell that
the *next* RSU over is also jammed. A fog node owns a small cluster of
nearby RSUs, aggregates their digests into one regional summary, and is
what actually reaches the cloud -- an extra hop of bandwidth reduction plus
a tier that reasons across RSU-cell boundaries. When a whole region's
average occupancy crosses a threshold, the fog node raises a regional
alert (visualized as a halo around its cluster) rather than leaving each
RSU to independently notice its own slice of the same jam.
"""
from __future__ import annotations

from dataclasses import dataclass, field

REGIONAL_ALERT_THRESHOLD = 0.6


@dataclass
class RegionalSummary:
    tick: int
    fog_id: str
    rsu_ids: list[str]
    avg_occupancy: float
    incident_count: int
    vehicles_served: int
    alert: bool


@dataclass
class FogNode:
    id: str
    member_rsu_ids: list[str]
    x: float
    y: float
    history: list[RegionalSummary] = field(default_factory=list)
    alert: bool = False

    def aggregate(self, tick: int, rsus: dict, rsu_network) -> RegionalSummary | None:
        members = [rsus[r] for r in self.member_rsu_ids if r in rsus and rsus[r].alive]
        if not members:
            self.alert = False
            return None

        all_segments = [seg for rsu in members for seg in rsu.local_segments()]
        avg_occ = sum(s.occupancy for s in all_segments) / len(all_segments) if all_segments else 0.0
        incidents = sum(1 for s in all_segments if s.confirmed_incident)
        vehicles_served = sum(
            1 for _vehicle_id, rsu_id in rsu_network.vehicle_cell.items() if rsu_id in self.member_rsu_ids
        )

        self.alert = avg_occ >= REGIONAL_ALERT_THRESHOLD
        summary = RegionalSummary(
            tick=tick,
            fog_id=self.id,
            rsu_ids=list(self.member_rsu_ids),
            avg_occupancy=round(avg_occ, 3),
            incident_count=incidents,
            vehicles_served=vehicles_served,
            alert=self.alert,
        )
        self.history.append(summary)
        if len(self.history) > 100:
            self.history.pop(0)
        return summary

    def to_state(self) -> dict:
        latest = self.history[-1] if self.history else None
        return {
            "id": self.id,
            "x": self.x,
            "y": self.y,
            "member_rsu_ids": self.member_rsu_ids,
            "alert": self.alert,
            "avg_occupancy": latest.avg_occupancy if latest else 0.0,
            "incident_count": latest.incident_count if latest else 0,
            "vehicles_served": latest.vehicles_served if latest else 0,
        }


def build_fog_clusters(rsu_ids: list[str], rsu_coords: dict[str, tuple[float, float]], cluster_size: int = 3) -> list[FogNode]:
    """Group RSUs into geographically coherent fog clusters of roughly
    `cluster_size`. Sorting by (x, y) before chunking keeps each cluster a
    contiguous district (e.g. the west side, then the east side) instead of
    grouping RSUs that happen to share an id prefix but sit on opposite
    sides of the city.
    """
    ordered = sorted(rsu_ids, key=lambda r: (rsu_coords[r][0], rsu_coords[r][1]))
    nodes = []
    for i in range(0, len(ordered), cluster_size):
        chunk = ordered[i : i + cluster_size]
        if not chunk:
            continue
        xs = [rsu_coords[r][0] for r in chunk]
        ys = [rsu_coords[r][1] for r in chunk]
        nodes.append(
            FogNode(
                id=f"fog-{len(nodes) + 1}",
                member_rsu_ids=chunk,
                x=sum(xs) / len(xs),
                y=sum(ys) / len(ys),
            )
        )
    return nodes
