"""Architecture configuration.

Slide 17 of the project deck proposes three experimental configurations:

  Exp 1  Centralized baseline (cloud only)
  Exp 2  V2X + RSU without edge intelligence
  Exp 3  Full proposed architecture (Edge AI + FL + Digital Twin sync)

Rather than maintaining three code paths, the simulation engine reads a
single `ArchitectureConfig` and enables/disables each architectural
capability. That way the comparison is genuinely apples-to-apples: the
same traffic, the same hazards, the same vehicles -- only the
architecture differs.
"""
from __future__ import annotations

from dataclasses import dataclass, replace


@dataclass(frozen=True)
class ArchitectureConfig:
    key: str
    label: str
    summary: str

    # L2 -- direct vehicle-to-vehicle exchange (DSRC / C-V2X PC5 sidelink)
    v2v_enabled: bool = True
    # L3 -- RSUs run local inference instead of only forwarding
    rsu_edge_ai: bool = True
    # L4 -- regional model training via federated averaging
    federated_learning: bool = True
    # L5 -- continuously synchronized digital twin of the road network
    digital_twin_sync: bool = True
    # M6 acting on peer data: vehicles reroute around congestion themselves
    predictive_rerouting: bool = True
    # M10 -- predictive emergency corridor formation
    emergency_corridor: bool = True
    # M6b -- vehicles announce where they intend to go (MCM) and price a
    # detour by how many peers have already claimed it. Off by default: it is
    # the variable under test, not part of the proposed baseline.
    intent_coordination: bool = False

    # Extra delay (in ticks) before a decision is available, when the
    # decision has to make a cloud round trip instead of being made locally.
    cloud_round_trip_ticks: int = 0
    # If True, losing the cloud uplink disables safety messaging entirely --
    # the failure mode the deck calls out in "Resilience Failures".
    cloud_dependent: bool = False

    def describe(self) -> dict:
        return {
            "key": self.key,
            "label": self.label,
            "summary": self.summary,
            "v2v_enabled": self.v2v_enabled,
            "rsu_edge_ai": self.rsu_edge_ai,
            "federated_learning": self.federated_learning,
            "digital_twin_sync": self.digital_twin_sync,
            "predictive_rerouting": self.predictive_rerouting,
            "emergency_corridor": self.emergency_corridor,
            "intent_coordination": self.intent_coordination,
            "cloud_round_trip_ticks": self.cloud_round_trip_ticks,
            "cloud_dependent": self.cloud_dependent,
        }


EXP1_CENTRALIZED = ArchitectureConfig(
    key="exp1_centralized",
    label="Exp 1 — Centralized baseline (cloud only)",
    summary=(
        "Vehicles are sensors that upload to the cloud; every decision makes a cloud round "
        "trip. No direct V2V, no edge inference. Losing the uplink means losing the service."
    ),
    v2v_enabled=False,
    rsu_edge_ai=False,
    federated_learning=False,
    digital_twin_sync=True,
    predictive_rerouting=False,
    emergency_corridor=True,
    cloud_round_trip_ticks=6,
    cloud_dependent=True,
)

EXP2_V2X_NO_EDGE_AI = ArchitectureConfig(
    key="exp2_v2x_no_edge_ai",
    label="Exp 2 — V2X + RSU without edge intelligence",
    summary=(
        "Direct V2V/V2I messaging works and RSUs aggregate traffic, but RSUs only forward -- "
        "no local inference, no federated learning, no predictive traffic management."
    ),
    v2v_enabled=True,
    rsu_edge_ai=False,
    federated_learning=False,
    digital_twin_sync=False,
    predictive_rerouting=True,
    emergency_corridor=True,
    cloud_round_trip_ticks=3,
    cloud_dependent=False,
)

EXP3_FULL = ArchitectureConfig(
    key="exp3_full",
    label="Exp 3 — Full proposed architecture",
    summary=(
        "Edge AI at every RSU, federated learning across the region, continuous digital twin "
        "synchronization, and peer-driven predictive rerouting. Safety messaging survives a "
        "cloud outage."
    ),
    v2v_enabled=True,
    rsu_edge_ai=True,
    federated_learning=True,
    digital_twin_sync=True,
    predictive_rerouting=True,
    emergency_corridor=True,
    cloud_round_trip_ticks=0,
    cloud_dependent=False,
)

#: Exp 3 with one variable changed and nothing else, so any difference in the
#: results is attributable to intent coordination rather than to a bundle of
#: changes moving together.
EXP4_COORDINATED = replace(
    EXP3_FULL,
    key="exp4_coordinated",
    label="Exp 4 — Proposed + intent coordination",
    summary=(
        "Exp 3, plus vehicles announcing where they intend to go (MCM) so a detour is "
        "priced by how many peers have already claimed it. Tests whether coordination "
        "beats the greedy rerouting that stampedes a platoon onto one alternative."
    ),
    intent_coordination=True,
)

CONFIGS: dict[str, ArchitectureConfig] = {
    cfg.key: cfg for cfg in (EXP1_CENTRALIZED, EXP2_V2X_NO_EDGE_AI, EXP3_FULL, EXP4_COORDINATED)
}

DEFAULT_CONFIG = EXP3_FULL
