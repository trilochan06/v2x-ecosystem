"""Global hazard-report corroboration and trust scoring.

Corroboration has to be judged across the whole network, not per-RSU: two
vehicles reporting the same segment to two different (neighbouring) RSUs
are just as independent a confirmation as two reports landing on the same
RSU. Centralizing the recent-report window here is what turns raw hazard
reports into a corroborated, trust-weighted incident flag.

One subtlety that matters for fairness. "Nobody confirmed this report" and
"nobody was *able* to confirm this report" look identical in the data but
mean opposite things: the first is evidence of misbehaviour, the second is
just an empty road. Scoring them the same way steadily destroys the
reputation of honest vehicles that happen to drive quiet streets -- which
is exactly what happened here before `witnesses` was threaded through.
A report no other vehicle was positioned to witness now leaves trust
untouched instead of counting against the reporter.
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
    newly_confirmed: set[str] = field(default_factory=set)
    unwitnessed_reports: int = 0
    # (sender, segment) -> tick last scored. A vehicle driving through a
    # hazard re-reports it every tick; those are repeats of one observation,
    # not fresh evidence, and scoring each one separately would bankrupt the
    # reputation of any vehicle unlucky enough to sit in traffic.
    _scored: dict[tuple[str, str], int] = field(default_factory=dict)

    def process(
        self,
        reports: list[tuple[str, Message]],
        trust: TrustRegistry,
        grid: CityGrid,
        tick: int,
        metrics=None,
        witnesses: dict[str, set[str]] | None = None,
    ) -> set[str]:
        """reports: deduplicated (sender_id, Message) hazard reports
        delivered anywhere in the network this tick. Returns the set of
        segment ids newly confirmed as an active incident.
        """
        self.recent = [r for r in self.recent if tick - r["tick"] <= CORROBORATION_WINDOW_TICKS]
        self._scored = {
            key: t for key, t in self._scored.items() if tick - t <= CORROBORATION_WINDOW_TICKS * 3
        }
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

            could_be_witnessed = True
            if witnesses is not None:
                could_be_witnessed = bool(witnesses.get(seg_id, set()) - {sender})

            last_scored = self._scored.get((sender, seg_id))
            is_repeat = last_scored is not None and tick - last_scored <= CORROBORATION_WINDOW_TICKS

            if is_repeat:
                pass  # same observation, already counted
            elif corroborated or could_be_witnessed:
                trust.record_report(sender, corroborated)
                self._scored[(sender, seg_id)] = tick
            else:
                # An empty road is not evidence of lying.
                self.unwitnessed_reports += 1

            if corroborated and trust.is_trusted(sender):
                confirmed_segments.add(seg_id)

        newly_confirmed: set[str] = set()
        for seg_id in confirmed_segments:
            seg = grid.segments.get(seg_id)
            if seg is None:
                continue
            # `confirm_incident` records the network's *belief*. Whether that
            # belief is correct is scored separately against seg.hazard_active,
            # which is how detection precision stays honest.
            if seg.confirm_incident(tick, INCIDENT_DURATION_TICKS):
                newly_confirmed.add(seg_id)
            if metrics is not None:
                metrics.incident_confirmed(seg_id, tick, seg.hazard_active)

        self.newly_confirmed = newly_confirmed
        return confirmed_segments
