"""Global hazard-report corroboration.

Corroboration has to be judged across the whole network, not per-RSU: two
vehicles reporting the same segment to two different (neighboring) RSUs
are just as independent a confirmation as two reports landing on the same
RSU. Centralizing the recent-report window here (instead of duplicating it
per RSU) is what makes that possible, and is the piece that turns raw
hazard reports into a corroborated, trust-weighted incident flag on the
shared road graph.
"""
from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass, field

from app.network.messages import Message
from app.network.security import TrustRegistry
from app.simulation.world import CityGrid

CORROBORATION_WINDOW_TICKS = 10
INCIDENT_DURATION_TICKS = 50


@dataclass
class CorroborationEngine:
    recent: list[dict] = field(default_factory=list)

    def process(
        self,
        reports: list[tuple[str, Message]],
        trust: TrustRegistry,
        grid: CityGrid,
        tick: int,
    ) -> set[str]:
        """reports: deduplicated (sender_id, Message) hazard reports
        delivered anywhere in the network this tick. Returns the set of
        segment ids newly confirmed as an active incident.
        """
        self.recent = [r for r in self.recent if tick - r["tick"] <= CORROBORATION_WINDOW_TICKS]
        self.recent += [
            {"tick": tick, "sender": sender, "segment_id": m.payload["segment_id"]} for sender, m in reports
        ]

        by_segment: dict[str, list[dict]] = defaultdict(list)
        for r in self.recent:
            by_segment[r["segment_id"]].append(r)

        confirmed_segments: set[str] = set()
        for sender, m in reports:
            seg_id = m.payload["segment_id"]
            independent_senders = {r["sender"] for r in by_segment[seg_id] if r["sender"] != sender}
            corroborated = len(independent_senders) >= 1
            trust.record_report(sender, corroborated)
            if corroborated and trust.is_trusted(sender):
                confirmed_segments.add(seg_id)

        for seg_id in confirmed_segments:
            seg = grid.segments.get(seg_id)
            if seg is not None:
                seg.incident = True
                seg.incident_ttl = INCIDENT_DURATION_TICKS

        return confirmed_segments
