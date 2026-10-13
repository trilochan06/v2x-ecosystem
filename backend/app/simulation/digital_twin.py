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

Divergence is a single number for the whole network, which is the right
figure for comparing architectures but says nothing about *where* the
replica is wrong, and the two ways it can be wrong have opposite
operational meanings. A road carrying a hazard nobody corroborated is a
detection failure -- the network is blind to something real. A road the
network is convinced about that carries nothing is a false alarm, which
is what a successful injection attack looks like from the outside. Both
show up in the mean as the same small number, so `anomalies` classifies
them per segment instead of leaving them averaged together.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.simulation.world import CityGrid

#: How far one road's replica occupancy may sit from physical truth before
#: it is called out individually rather than absorbed into the mean.
SEGMENT_DRIFT_THRESHOLD = 0.35
#: Anomalies kept for display. Older ones are dropped, not aggregated,
#: because the counts are reported separately and never recomputed.
ANOMALY_HISTORY_LIMIT = 60


@dataclass
class TwinSegment:
    occupancy: float = 0.0
    confirmed_incident: bool = False
    last_sync_tick: int = -1


@dataclass
class TwinAnomaly:
    """One road where replica and reality disagree, and in which direction."""

    tick: int
    segment_id: str
    #: ``unmodelled_incident`` -- a real hazard the network never confirmed.
    #: ``phantom_incident``    -- a confirmation with no hazard behind it.
    #: ``occupancy_drift``     -- the replica's traffic estimate has gone stale.
    kind: str
    replica_occupancy: float
    physical_occupancy: float
    gap: float


@dataclass
class DigitalTwin:
    grid: CityGrid
    state: dict[str, TwinSegment] = field(default_factory=dict)
    sync_count: int = 0
    last_sync_tick: int = -1
    bytes_synced: int = 0
    anomalies: list[TwinAnomaly] = field(default_factory=list)
    anomaly_count: int = 0
    #: (segment, kind) pairs already reported and not yet resolved. Without
    #: this a single hazard raises the same anomaly on every sync for as long
    #: as it lasts, which buries the distinct events in its own repeats.
    _open: set[tuple[str, str]] = field(default_factory=set)

    def __post_init__(self) -> None:
        for seg in self.grid.all_segments():
            self.state[seg.id] = TwinSegment()

    def _classify(self, seg, twin: TwinSegment) -> str | None:
        """Name the disagreement on one road, or None if there is none.

        Incident mismatches are checked before occupancy because they are
        the more specific finding: a blocked road also drifts in occupancy,
        and reporting that instead would describe the symptom rather than
        the cause.
        """
        if seg.hazard_active and not seg.confirmed_incident:
            return "unmodelled_incident"
        if seg.confirmed_incident and not seg.hazard_active:
            return "phantom_incident"
        if abs(twin.occupancy - seg.occupancy) >= SEGMENT_DRIFT_THRESHOLD:
            return "occupancy_drift"
        return None

    def _measure(self, tick: int) -> None:
        """Compare replica against physical truth, before the sync overwrites
        the evidence. Nothing here is visible to the network -- the twin is
        the one component entitled to read ground truth, because measuring
        its own error is the whole reason it exists."""
        for seg in self.grid.all_segments():
            twin = self.state[seg.id]
            kind = self._classify(seg, twin)

            # Clear anything previously open on this road that no longer
            # holds, so a genuine recurrence is reported again later.
            for stale in [k for (sid, k) in self._open if sid == seg.id and k != kind]:
                self._open.discard((seg.id, stale))

            if kind is None:
                continue
            if (seg.id, kind) in self._open:
                continue
            self._open.add((seg.id, kind))
            self.anomaly_count += 1
            self.anomalies.append(
                TwinAnomaly(
                    tick=tick,
                    segment_id=seg.id,
                    kind=kind,
                    replica_occupancy=round(twin.occupancy, 3),
                    physical_occupancy=round(seg.occupancy, 3),
                    gap=round(abs(twin.occupancy - seg.occupancy), 3),
                )
            )
            if len(self.anomalies) > ANOMALY_HISTORY_LIMIT:
                self.anomalies.pop(0)

    def sync(self, tick: int) -> None:
        """Pull the live road state into the replica. Each synced segment
        costs uplink bandwidth, which is why real deployments sync at a
        bounded rate rather than continuously."""
        self._measure(tick)
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
            "anomaly_count": self.anomaly_count,
            "anomalies": [a.__dict__ for a in self.anomalies[-12:]],
        }
