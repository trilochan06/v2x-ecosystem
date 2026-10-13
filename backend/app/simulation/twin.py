"""Transportation digital twin: a synchronised replica of the road network
that is honest about how far behind reality it is.

Two properties separate a twin from a dashboard, and both are published
here. **Staleness** is how many ticks old the replica is; a copy whose age
is unknown cannot be reasoned about safely, so every consumer is told.
**Divergence** is how far the replica has drifted from the physical state
it claims to mirror, and it is useful twice over: as a quality indicator,
and as a detector in its own right. A replica that departs from reality
beyond an expected bound is reporting that something is happening which
the model does not represent -- an unreported incident, a failed sensor,
or a node reporting falsely.

The replica is deliberately NOT a reference to the live grid. It holds its
own copy, refreshed on a fixed interval, so that divergence is a real
quantity rather than always zero by construction.
"""
from __future__ import annotations

from dataclasses import dataclass, field

SYNC_INTERVAL_TICKS = 2
# Mean absolute occupancy error above which the replica is no longer
# trustworthy enough to answer questions with.
DIVERGENCE_ALERT_THRESHOLD = 0.12
# Per-segment gap that marks one road as anomalous rather than merely stale.
SEGMENT_ANOMALY_THRESHOLD = 0.35
HISTORY_LIMIT = 120


@dataclass
class TwinSegment:
    """What the twin believes about one road."""

    id: str
    occupancy: float
    incident: bool
    synced_tick: int


@dataclass
class TwinAnomaly:
    tick: int
    segment_id: str
    replica_occupancy: float
    physical_occupancy: float
    gap: float
    kind: str  # "occupancy_drift" | "unmodelled_incident" | "phantom_incident"


@dataclass
class TransportDigitalTwin:
    """A replica of the city that knows how wrong it is."""

    sync_interval: int = SYNC_INTERVAL_TICKS
    segments: dict[str, TwinSegment] = field(default_factory=dict)
    last_sync_tick: int = -1
    divergence: float = 0.0
    max_segment_gap: float = 0.0
    divergence_history: list[float] = field(default_factory=list)
    anomalies: list[TwinAnomaly] = field(default_factory=list)
    syncs: int = 0
    alert: bool = False
    # (segment, kind) pairs already reported. A hazard that stays unconfirmed
    # for fifty ticks is one anomaly, not one every sync -- recording it on
    # every pass buries the new information under repeats of the old.
    _open: set = field(default_factory=set)

    # ------------------------------------------------------------- lifecycle
    def should_sync(self, tick: int) -> bool:
        return tick % self.sync_interval == 0

    def sync(self, grid, tick: int) -> None:
        """Pull a fresh copy of every segment and record how far the previous
        copy had drifted before it was replaced.

        The replica is built from what the infrastructure *believes*
        (`reported_incident`), because that is all a twin fed by the network
        could ever know. Divergence is then measured against physical truth,
        which is what makes the measurement worth anything.
        """
        self._measure(grid, tick)
        for seg in grid.all_segments():
            self.segments[seg.id] = TwinSegment(
                id=seg.id,
                occupancy=seg.occupancy,
                incident=seg.reported_incident,
                synced_tick=tick,
            )
        self.last_sync_tick = tick
        self.syncs += 1

    def staleness(self, tick: int) -> int:
        if self.last_sync_tick < 0:
            return tick
        return tick - self.last_sync_tick

    # -------------------------------------------------------------- analysis
    def _measure(self, grid, tick: int) -> None:
        """Compare the replica against physical state *before* refreshing it.

        Divergence is the mean absolute occupancy gap across the network.
        Anything beyond the per-segment threshold is recorded as an anomaly,
        classified by what kind of disagreement it is: an incident the twin
        does not know about is a different problem from one it believes in
        that has already cleared.
        """
        if not self.segments:
            return

        total = 0.0
        worst = 0.0
        for seg in grid.all_segments():
            replica = self.segments.get(seg.id)
            if replica is None:
                continue
            gap = abs(replica.occupancy - seg.occupancy)
            total += gap
            worst = max(worst, gap)

            kind = ""
            if seg.incident and not replica.incident:
                kind = "unmodelled_incident"
            elif replica.incident and not seg.incident:
                kind = "phantom_incident"
            elif gap >= SEGMENT_ANOMALY_THRESHOLD:
                kind = "occupancy_drift"
            key = (seg.id, kind)
            if kind and key not in self._open:
                self._open.add(key)
                self.anomalies.append(
                    TwinAnomaly(
                        tick=tick,
                        segment_id=seg.id,
                        replica_occupancy=round(replica.occupancy, 3),
                        physical_occupancy=round(seg.occupancy, 3),
                        gap=round(gap, 3),
                        kind=kind,
                    )
                )
            # Once the disagreement resolves, the same segment may legitimately
            # raise that kind of anomaly again later.
            for other in ("occupancy_drift", "unmodelled_incident", "phantom_incident"):
                if other != kind:
                    self._open.discard((seg.id, other))

        count = max(1, len(self.segments))
        self.divergence = total / count
        self.max_segment_gap = worst
        self.alert = self.divergence >= DIVERGENCE_ALERT_THRESHOLD

        self.divergence_history.append(round(self.divergence, 4))
        if len(self.divergence_history) > HISTORY_LIMIT:
            self.divergence_history.pop(0)
        if len(self.anomalies) > HISTORY_LIMIT:
            del self.anomalies[:-HISTORY_LIMIT]

    # ---------------------------------------------------------------- query
    def query(self, segment_id: str, tick: int) -> dict | None:
        """What the twin would answer if asked about one road, with the age
        of the answer attached. Consumers that cannot tolerate the staleness
        are expected to say so rather than silently trusting it."""
        replica = self.segments.get(segment_id)
        if replica is None:
            return None
        return {
            "segment_id": replica.id,
            "occupancy": round(replica.occupancy, 3),
            "incident": replica.incident,
            "as_of_tick": replica.synced_tick,
            "staleness_ticks": tick - replica.synced_tick,
        }

    def to_state(self, tick: int) -> dict:
        recent = self.anomalies[-12:]
        return {
            "synced_tick": self.last_sync_tick,
            "staleness_ticks": self.staleness(tick),
            "sync_interval": self.sync_interval,
            "syncs": self.syncs,
            "replica_segments": len(self.segments),
            "divergence": round(self.divergence, 4),
            "max_segment_gap": round(self.max_segment_gap, 3),
            "alert": self.alert,
            "alert_threshold": DIVERGENCE_ALERT_THRESHOLD,
            "divergence_history": self.divergence_history[-60:],
            "anomalies": [a.__dict__ for a in reversed(recent)],
            "anomaly_count": len(self.anomalies),
        }
