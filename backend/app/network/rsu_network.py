"""RSU topology, self-healing cell handover, and cloud digest aggregation.

Vehicles are assigned to the nearest *alive* RSU cell. If an RSU goes down
(hardware fault, power loss, link outage) the network does not wait for a
human to reroute traffic: on the next health check every orphaned vehicle
is silently reassigned to the nearest surviving RSU. Only compact digests
(not raw per-vehicle telemetry) are ever forwarded to the national cloud
layer, which is what keeps the uplink bandwidth bounded regardless of how
many vehicles are on the road.
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass
class CloudDigest:
    tick: int
    rsu_id: str
    segment_count: int
    avg_occupancy: float
    incident_count: int
    vehicles_served: int


class RSUNetwork:
    def __init__(self):
        self.rsu_positions: dict[str, str] = {}  # rsu_id -> grid node
        self.alive: dict[str, bool] = {}
        self.vehicle_cell: dict[str, str] = {}  # vehicle_id -> rsu_id
        self.cloud_digests: list[CloudDigest] = []
        self.handover_log: list[dict] = []

    def register_rsu(self, rsu_id: str, grid_node: str) -> None:
        self.rsu_positions[rsu_id] = grid_node
        self.alive[rsu_id] = True

    def set_alive(self, rsu_id: str, alive: bool) -> None:
        self.alive[rsu_id] = alive

    def nearest_alive_rsu(self, grid, from_node: str) -> str | None:
        best_id, best_dist = None, None
        for rsu_id, node in self.rsu_positions.items():
            if not self.alive.get(rsu_id, False):
                continue
            dist = grid.euclidean(from_node, node)
            if best_dist is None or dist < best_dist:
                best_id, best_dist = rsu_id, dist

        return best_id

    def assign_vehicle(self, grid, vehicle_id: str, from_node: str, tick: int) -> str | None:
        current = self.vehicle_cell.get(vehicle_id)
        if current and self.alive.get(current, False):
            return current
        new_rsu = self.nearest_alive_rsu(grid, from_node)
        if new_rsu and new_rsu != current:
            self.vehicle_cell[vehicle_id] = new_rsu
            if current:
                self.handover_log.append(
                    {"tick": tick, "vehicle_id": vehicle_id, "from": current, "to": new_rsu, "reason": "self_heal"}
                )
                if len(self.handover_log) > 200:
                    self.handover_log.pop(0)
        return self.vehicle_cell.get(vehicle_id)

    def record_digest(self, digest: CloudDigest) -> None:
        self.cloud_digests.append(digest)
        if len(self.cloud_digests) > 500:
            self.cloud_digests.pop(0)
