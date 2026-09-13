"""M8 - Transportation Digital Twin (L5).

A continuously synchronized virtual replica of the road network. The twin
is deliberately a *separate copy* of the world rather than a view onto it,
because the interesting property is precisely how far the replica drifts
from reality when synchronization is degraded or switched off -- which is
the cost an architecture without digital-twin sync (Exp 2) pays, and which
the deck's literature review flags as "high continuous synchronization
overhead" on one side and "lacks real-time localized synchronization" on
the other.

`divergence()` quantifies that drift: mean absolute error between the
twin's belief about each segment's occupancy and the physical truth.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.simulation.world import CityGrid


@dataclass
class TwinSegment:
    occupancy: float = 0.0
    confirmed_incident: bool = False
    last_sync_tick: int = -1


@dataclass
class DigitalTwin:
    grid: CityGrid
    state: dict[str, TwinSegment] = field(default_factory=dict)
    sync_count: int = 0
    last_sync_tick: int = -1
    bytes_synced: int = 0

    def __post_init__(self) -> None:
        for seg in self.grid.all_segments():
            self.state[seg.id] = TwinSegment()

    def sync(self, tick: int) -> None:
        """Pull the live road state into the replica. Each synced segment
        costs uplink bandwidth, which is why real deployments sync at a
        bounded rate rather than continuously."""
        for seg in self.grid.all_segments():
            twin = self.state[seg.id]
            twin.occupancy = seg.occupancy
            twin.confirmed_incident = seg.confirmed_incident
            twin.last_sync_tick = tick
        self.sync_count += 1
        self.last_sync_tick = tick
        # ~12 bytes per segment record on the uplink
        self.bytes_synced += 12 * len(self.state)

    def divergence(self) -> float:
        """Mean absolute error between the replica and physical reality."""
        if not self.state:
            return 0.0
        total = 0.0
        for seg in self.grid.all_segments():
            total += abs(self.state[seg.id].occupancy - seg.occupancy)
        return total / len(self.state)

    def staleness(self, tick: int) -> int:
        return 0 if self.last_sync_tick < 0 else tick - self.last_sync_tick

    def congested_segments(self, threshold: float = 0.7) -> list[str]:
        return [sid for sid, twin in self.state.items() if twin.occupancy >= threshold]

    def snapshot(self, tick: int) -> dict:
        return {
            "syncs": self.sync_count,
            "last_sync_tick": self.last_sync_tick,
            "staleness_ticks": self.staleness(tick),
            "divergence": round(self.divergence(), 4),
            "kilobytes_synced": round(self.bytes_synced / 1024, 2),
            "congested_segments": len(self.congested_segments()),
            "tracked_segments": len(self.state),
        }
