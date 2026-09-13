"""M9 - Decision & Alert Engine.

Confirming an incident is not the same as warning the drivers who are
about to reach it. This module decides *relevance* (which vehicles have
that segment coming up on their route), *priority*, and *delivery timing*.

Delivery timing is where the architecture comparison shows up most
sharply. In the full architecture the decision is made at the RSU next to
the incident and the warning goes out over V2X immediately
(`cloud_round_trip_ticks == 0`). In the centralized baseline the report
has to reach the cloud, be processed, and come back before anyone is told
-- so the identical hazard produces a materially later warning, which is
exactly what the end-to-end latency metric captures.
"""
from __future__ import annotations

from dataclasses import dataclass, field

ALERT_LOOKAHEAD_HOPS = 4


@dataclass
class PendingAlert:
    segment_id: str
    deliver_at_tick: int
    raised_tick: int
    reason: str


@dataclass
class AlertEngine:
    cloud_round_trip_ticks: int = 0
    queue: list[PendingAlert] = field(default_factory=list)
    delivered: list[dict] = field(default_factory=list)
    alerts_raised: int = 0
    alerts_delivered: int = 0

    def raise_alert(self, segment_id: str, tick: int, reason: str) -> None:
        self.alerts_raised += 1
        self.queue.append(
            PendingAlert(
                segment_id=segment_id,
                deliver_at_tick=tick + self.cloud_round_trip_ticks,
                raised_tick=tick,
                reason=reason,
            )
        )

    def dispatch(self, tick: int, vehicles: list, metrics=None) -> list[dict]:
        """Deliver every alert whose (possibly cloud-delayed) time has come,
        to the vehicles for which it is actually relevant."""
        due = [a for a in self.queue if a.deliver_at_tick <= tick]
        if not due:
            return []
        self.queue = [a for a in self.queue if a.deliver_at_tick > tick]

        notifications: list[dict] = []
        for alert in due:
            recipients = [v for v in vehicles if self._is_relevant(v, alert.segment_id)]
            for vehicle in recipients:
                vehicle.receive_hazard_warning(alert.segment_id, tick)
            if recipients:
                self.alerts_delivered += 1
                if metrics is not None:
                    metrics.alert_delivered(alert.segment_id, tick)
            notifications.append(
                {
                    "tick": tick,
                    "segment_id": alert.segment_id,
                    "reason": alert.reason,
                    "recipients": len(recipients),
                    "latency_ticks": tick - alert.raised_tick,
                }
            )

        self.delivered = (self.delivered + notifications)[-40:]
        return notifications

    @staticmethod
    def _is_relevant(vehicle, segment_id: str) -> bool:
        """A warning matters to a vehicle whose next few hops cross it."""
        upcoming = vehicle.route[: ALERT_LOOKAHEAD_HOPS + 1]
        for i in range(len(upcoming) - 1):
            if vehicle.grid.segment_between(upcoming[i], upcoming[i + 1]).id == segment_id:
                return True
        return False

    def snapshot(self) -> dict:
        return {
            "alerts_raised": self.alerts_raised,
            "alerts_delivered": self.alerts_delivered,
            "queued": len(self.queue),
            "cloud_round_trip_ticks": self.cloud_round_trip_ticks,
            "recent": list(reversed(self.delivered[-12:])),
        }
