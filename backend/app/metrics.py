"""Evaluation metrics (project deck, slide 17).

  Communication   end-to-end latency, packet delivery ratio, message overhead
  Traffic impact  travel time, congestion duration
  AI & FL         hazard precision/recall, federated convergence
  Resilience      service availability during simulated outages

Detection quality is scored against the *physical* hazard state
(`Segment.hazard_active`), never against what the network believes, so a
configuration that confirms a fabricated hazard is correctly penalised.
"""
from __future__ import annotations

from dataclasses import dataclass, field

CONGESTION_THRESHOLD = 0.7


@dataclass
class HazardEpisode:
    """One physical hazard, from the moment it appears until it clears."""

    segment_id: str
    hazard_type: str
    started_tick: int
    detected_tick: int | None = None

    @property
    def detected(self) -> bool:
        return self.detected_tick is not None


@dataclass
class MetricsCollector:
    # --- communication ----------------------------------------------------
    # Local radio (V2V/V2I sidelink) and cloud uplink are separate, finite
    # resources and are deliberately NOT summed: the deck's objection to
    # centralized ITS is specifically about raw telemetry on the *uplink*
    # (bandwidth cost plus privacy exposure), and a design that chatters
    # locally to avoid the uplink is making a trade, not paying twice.
    packets_intended: int = 0
    packets_delivered: int = 0
    messages_sent: int = 0
    local_bytes: int = 0
    uplink_bytes: int = 0

    detection_latencies: list[int] = field(default_factory=list)
    alert_latencies: list[int] = field(default_factory=list)

    # --- traffic impact ---------------------------------------------------
    # `trip_times` only sees journeys that finish inside the run, which
    # over-samples short routes -- a survivorship bias that makes the average
    # depend on the window length. `segment_transitions / vehicle_ticks` has
    # no such bias: every vehicle contributes every tick whether or not it
    # ever reaches its destination, so it is the metric to compare on.
    trip_times: list[int] = field(default_factory=list)
    segment_transitions: int = 0
    vehicle_ticks: int = 0
    congested_samples: int = 0
    segment_samples: int = 0

    # --- detection quality ------------------------------------------------
    true_positives: int = 0
    false_positives: int = 0
    episodes: dict[str, HazardEpisode] = field(default_factory=dict)
    closed_episodes: list[HazardEpisode] = field(default_factory=list)

    # --- resilience -------------------------------------------------------
    service_up_ticks: int = 0
    total_ticks: int = 0
    outage_ticks: int = 0
    outage_service_up_ticks: int = 0

    # ---------------------------------------------------------------- comms
    def record_broadcast(self, intended: int, delivered: int, size_bytes: int) -> None:
        """One local V2X transmission. A broadcast is sent once on the air
        regardless of how many receivers decode it, so the frame is counted
        once -- not once per recipient."""
        self.messages_sent += 1
        self.packets_intended += intended
        self.packets_delivered += delivered
        self.local_bytes += size_bytes

    def record_uplink(self, size_bytes: int) -> None:
        """Bytes crossing the backhaul to the cloud: raw telemetry uploads,
        RSU digests, digital-twin sync, federated weight exchanges."""
        self.uplink_bytes += size_bytes

    # ------------------------------------------------------------- hazards
    def hazard_raised(self, segment_id: str, hazard_type: str, tick: int) -> None:
        self.episodes[segment_id] = HazardEpisode(
            segment_id=segment_id, hazard_type=hazard_type, started_tick=tick
        )

    def hazard_cleared(self, segment_id: str) -> None:
        episode = self.episodes.pop(segment_id, None)
        if episode is not None:
            self.closed_episodes.append(episode)

    def incident_confirmed(self, segment_id: str, tick: int, hazard_active: bool) -> None:
        """The network has corroborated an incident. Scored against reality."""
        if not hazard_active:
            self.false_positives += 1
            return
        self.true_positives += 1
        episode = self.episodes.get(segment_id)
        if episode is not None and not episode.detected:
            episode.detected_tick = tick
            self.detection_latencies.append(tick - episode.started_tick)

    def alert_delivered(self, segment_id: str, tick: int) -> None:
        """A warning about `segment_id` reached a vehicle that needed it."""
        episode = self.episodes.get(segment_id)
        if episode is not None:
            self.alert_latencies.append(tick - episode.started_tick)

    # ------------------------------------------------------------- traffic
    def trip_completed(self, ticks: int) -> None:
        self.trip_times.append(ticks)

    def sample_mobility(self, transitions: int, vehicle_ticks: int) -> None:
        self.segment_transitions += transitions
        self.vehicle_ticks += vehicle_ticks

    def sample_segments(self, occupancies: list[float]) -> None:
        self.segment_samples += len(occupancies)
        self.congested_samples += sum(1 for o in occupancies if o >= CONGESTION_THRESHOLD)

    # ---------------------------------------------------------- resilience
    def sample_availability(self, service_up: bool, in_outage: bool) -> None:
        self.total_ticks += 1
        if service_up:
            self.service_up_ticks += 1
        if in_outage:
            self.outage_ticks += 1
            if service_up:
                self.outage_service_up_ticks += 1

    # ------------------------------------------------------------- summary
    def summary(self) -> dict:
        missed = sum(1 for e in self.closed_episodes if not e.detected)
        missed += sum(1 for e in self.episodes.values() if not e.detected)
        detected = sum(1 for e in self.closed_episodes if e.detected)
        detected += sum(1 for e in self.episodes.values() if e.detected)

        precision = _ratio(self.true_positives, self.true_positives + self.false_positives)
        recall = _ratio(detected, detected + missed)
        f1 = 0.0 if (precision + recall) == 0 else 2 * precision * recall / (precision + recall)

        return {
            "communication": {
                "packet_delivery_ratio": round(_ratio(self.packets_delivered, self.packets_intended), 4),
                "avg_detection_latency_ticks": round(_mean(self.detection_latencies), 2),
                "avg_alert_latency_ticks": round(_mean(self.alert_latencies), 2),
                # Corroborated alerts are rare events; a mean over one or two
                # of them is noise, so the sample count travels with it.
                "alert_samples": len(self.alert_latencies),
                "detection_samples": len(self.detection_latencies),
                "messages_sent": self.messages_sent,
                "local_kilobytes": round(self.local_bytes / 1024, 1),
                "local_kilobytes_per_tick": round(self.local_bytes / 1024 / max(self.total_ticks, 1), 3),
                "uplink_kilobytes": round(self.uplink_bytes / 1024, 1),
                "uplink_kilobytes_per_tick": round(self.uplink_bytes / 1024 / max(self.total_ticks, 1), 3),
            },
            "traffic": {
                "segments_per_100_vehicle_ticks": round(
                    100 * _ratio(self.segment_transitions, self.vehicle_ticks), 3
                ),
                "segment_transitions": self.segment_transitions,
                "avg_trip_ticks": round(_mean(self.trip_times), 2),
                "trips_completed": len(self.trip_times),
                "congestion_duration_pct": round(
                    100 * _ratio(self.congested_samples, self.segment_samples), 2
                ),
            },
            "detection": {
                "precision": round(precision, 4),
                "recall": round(recall, 4),
                "f1": round(f1, 4),
                "true_positives": self.true_positives,
                "false_positives": self.false_positives,
                "hazards_detected": detected,
                "hazards_missed": missed,
            },
            "resilience": {
                "availability_pct": round(100 * _ratio(self.service_up_ticks, self.total_ticks), 2),
                "availability_during_outage_pct": round(
                    100 * _ratio(self.outage_service_up_ticks, self.outage_ticks), 2
                ),
                "outage_ticks": self.outage_ticks,
                "total_ticks": self.total_ticks,
            },
        }


def _ratio(numerator: int, denominator: int) -> float:
    return 0.0 if denominator == 0 else numerator / denominator


def _mean(values: list[int]) -> float:
    return 0.0 if not values else sum(values) / len(values)
