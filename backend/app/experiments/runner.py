"""Experimental evaluation (project deck, slide 17).

Runs the three proposed configurations over the same scenario and the same
random seed, so differences in the results come from the architecture
rather than from luck. Each run includes a scripted cloud outage window,
which is how "service availability during simulated outages" gets measured
rather than asserted.

The output of `run_suite()` is the empirical evidence the deck's Expected
Outcomes slide promises, in a shape the website renders directly.
"""
from __future__ import annotations

from dataclasses import dataclass

from app.config import CONFIGS, EXP1_CENTRALIZED, EXP2_V2X_NO_EDGE_AI, EXP3_FULL, ArchitectureConfig
from app.simulation.engine import SimulationEngine

DEFAULT_TICKS = 300
DEFAULT_SEED = 4242
# The scripted network disruption, as a fraction of the run.
OUTAGE_START_FRACTION = 0.55
OUTAGE_END_FRACTION = 0.75


@dataclass
class ScenarioSpec:
    key: str
    label: str
    description: str
    vehicles: int
    malicious: int
    ambulances: int


SCENARIOS: dict[str, ScenarioSpec] = {
    "normal": ScenarioSpec(
        key="normal",
        label="Normal traffic",
        description="Steady flow with organically occurring hazards.",
        vehicles=26,
        malicious=0,
        ambulances=0,
    ),
    "congestion": ScenarioSpec(
        key="congestion",
        label="Sudden congestion",
        description="Heavy load: more vehicles than the grid comfortably carries.",
        vehicles=44,
        malicious=0,
        ambulances=0,
    ),
    "emergency": ScenarioSpec(
        key="emergency",
        label="Emergency vehicle routing",
        description="Ambulances need a corridor through live traffic.",
        vehicles=30,
        malicious=0,
        ambulances=2,
    ),
    "attack": ScenarioSpec(
        key="attack",
        label="Malicious injection",
        description="Attackers inject false hazard reports into the network.",
        vehicles=30,
        malicious=4,
        ambulances=0,
    ),
}


def run_experiment(
    config: ArchitectureConfig,
    scenario: ScenarioSpec,
    ticks: int = DEFAULT_TICKS,
    seed: int = DEFAULT_SEED,
) -> dict:
    engine = SimulationEngine(
        grid_size=6,
        num_rsus=6,
        num_vehicles=scenario.vehicles,
        config=config,
        seed=seed,
        inference_interval=3,
        explain_predictions=False,
    )
    for _ in range(scenario.malicious):
        engine.spawn_vehicle("malicious")
    for _ in range(scenario.ambulances):
        engine.spawn_vehicle("ambulance")

    outage_start = int(ticks * OUTAGE_START_FRACTION)
    outage_end = int(ticks * OUTAGE_END_FRACTION)

    for t in range(ticks):
        if t == outage_start:
            engine.set_cloud_online(False)
        elif t == outage_end:
            engine.set_cloud_online(True)
        engine.step()

    metrics = engine.metrics.summary()
    federated = engine.federation.snapshot()
    twin = engine.twin.snapshot(engine.tick)

    return {
        "config": config.describe(),
        "scenario": {
            "key": scenario.key,
            "label": scenario.label,
            "description": scenario.description,
            "vehicles": scenario.vehicles,
            "malicious": scenario.malicious,
            "ambulances": scenario.ambulances,
        },
        "ticks": ticks,
        "seed": seed,
        "metrics": metrics,
        "federated": {
            "rounds_completed": federated["rounds_completed"],
            "loss_reduction_pct": federated["loss_reduction_pct"],
            "convergence_round": federated["convergence_round"],
            "raw_kilobytes_avoided": federated["total_raw_kilobytes_avoided"],
            "weights_kilobytes": federated["total_weights_kilobytes"],
        },
        "digital_twin": twin,
        "outage_window": {"start": outage_start, "end": outage_end},
    }


def run_suite(
    scenario_key: str = "normal",
    ticks: int = DEFAULT_TICKS,
    seed: int = DEFAULT_SEED,
) -> dict:
    scenario = SCENARIOS.get(scenario_key, SCENARIOS["normal"])
    runs = [
        run_experiment(cfg, scenario, ticks=ticks, seed=seed)
        for cfg in (EXP1_CENTRALIZED, EXP2_V2X_NO_EDGE_AI, EXP3_FULL)
    ]
    return {
        "scenario": runs[0]["scenario"],
        "ticks": ticks,
        "seed": seed,
        "runs": runs,
        "headline": _headline(runs),
    }


def _headline(runs: list[dict]) -> dict:
    """The three comparisons a panel will actually ask about."""
    baseline, _mid, full = runs[0], runs[1], runs[2]

    def latency(run: dict) -> float:
        return run["metrics"]["communication"]["avg_alert_latency_ticks"]

    def overhead(run: dict) -> float:
        # Uplink specifically: the backhaul/cellular resource a cloud-only
        # design saturates with raw telemetry, and the one the deck's
        # bandwidth and privacy arguments are actually about.
        return run["metrics"]["communication"]["uplink_kilobytes_per_tick"]

    def availability(run: dict) -> float:
        return run["metrics"]["resilience"]["availability_during_outage_pct"]

    return {
        "alert_latency": {
            "baseline": latency(baseline),
            "proposed": latency(full),
            "improvement_pct": _pct_drop(latency(baseline), latency(full)),
            "unit": "ticks",
            "label": "Hazard-to-warning latency",
        },
        "message_overhead": {
            "baseline": overhead(baseline),
            "proposed": overhead(full),
            "improvement_pct": _pct_drop(overhead(baseline), overhead(full)),
            "unit": "KB/tick",
            "label": "Uplink overhead",
        },
        "availability_during_outage": {
            "baseline": availability(baseline),
            "proposed": availability(full),
            "improvement_pct": round(availability(full) - availability(baseline), 2),
            "unit": "%",
            "label": "Availability during cloud outage",
        },
    }


def _pct_drop(baseline: float, proposed: float) -> float:
    if baseline <= 0:
        return 0.0
    return round(100 * (baseline - proposed) / baseline, 2)


def list_configs() -> list[dict]:
    return [cfg.describe() for cfg in CONFIGS.values()]


def list_scenarios() -> list[dict]:
    return [
        {
            "key": s.key,
            "label": s.label,
            "description": s.description,
            "vehicles": s.vehicles,
            "malicious": s.malicious,
            "ambulances": s.ambulances,
        }
        for s in SCENARIOS.values()
    ]
