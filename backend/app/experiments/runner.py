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
from app.stats import Estimate, separated, summarize

DEFAULT_TICKS = 300
DEFAULT_SEED = 4242
#: Seeds per configuration. One seed is a sample, not a result -- see
#: app/stats.py for why every figure carries a confidence interval.
DEFAULT_REPEATS = 3
MAX_REPEATS = 10

#: The metrics worth aggregating across seeds, as (section, key) into a
#: metrics summary.
AGGREGATED_METRICS: dict[str, tuple[str, str]] = {
    "uplink_kilobytes_per_tick": ("communication", "uplink_kilobytes_per_tick"),
    "local_kilobytes_per_tick": ("communication", "local_kilobytes_per_tick"),
    "packet_delivery_ratio": ("communication", "packet_delivery_ratio"),
    "avg_alert_latency_ticks": ("communication", "avg_alert_latency_ticks"),
    "alert_samples": ("communication", "alert_samples"),
    "precision": ("detection", "precision"),
    "recall": ("detection", "recall"),
    "f1": ("detection", "f1"),
    "segments_per_100_vehicle_ticks": ("traffic", "segments_per_100_vehicle_ticks"),
    "congestion_duration_pct": ("traffic", "congestion_duration_pct"),
    "availability_during_outage_pct": ("resilience", "availability_during_outage_pct"),
}
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


def aggregate_runs(runs: list[dict]) -> dict[str, Estimate]:
    """Mean and 95% interval for each tracked metric across seeds."""
    out: dict[str, Estimate] = {}
    for name, (section, key) in AGGREGATED_METRICS.items():
        out[name] = summarize([float(r["metrics"][section][key]) for r in runs])
    return out


def run_suite(
    scenario_key: str = "normal",
    ticks: int = DEFAULT_TICKS,
    seed: int = DEFAULT_SEED,
    repeats: int = DEFAULT_REPEATS,
) -> dict:
    """Run all three architectures over `repeats` seeds each.

    Every configuration sees the *same* set of seeds, so a difference between
    them cannot come from one having drawn an easier run.
    """
    scenario = SCENARIOS.get(scenario_key, SCENARIOS["normal"])
    repeats = max(1, min(repeats, MAX_REPEATS))
    seeds = [seed + i for i in range(repeats)]

    configs = (EXP1_CENTRALIZED, EXP2_V2X_NO_EDGE_AI, EXP3_FULL)
    by_config = [[run_experiment(cfg, scenario, ticks=ticks, seed=s) for s in seeds] for cfg in configs]

    aggregates = [aggregate_runs(runs) for runs in by_config]
    return {
        "scenario": by_config[0][0]["scenario"],
        "ticks": ticks,
        "seed": seed,
        "seeds": seeds,
        "repeats": repeats,
        # The first seed's runs, kept for the per-configuration detail tables.
        "runs": [runs[0] for runs in by_config],
        "aggregates": [
            {"config_key": cfg.key, "metrics": {k: v.as_dict() for k, v in agg.items()}}
            for cfg, agg in zip(configs, aggregates, strict=True)
        ],
        "headline": _headline(aggregates),
    }


def _headline(aggregates: list[dict[str, Estimate]]) -> dict:
    """The three comparisons a panel will actually ask about, as means over
    every seed with the interval that belongs to them."""
    baseline, _mid, full = aggregates[0], aggregates[1], aggregates[2]

    def compare(metric: str, unit: str, label: str, higher_is_better: bool = False) -> dict:
        b, p = baseline[metric], full[metric]
        improvement = (
            round(p.mean - b.mean, 2) if higher_is_better else _pct_drop(b.mean, p.mean)
        )
        return {
            "baseline": round(b.mean, 4),
            "baseline_half_width": round(b.half_width, 4),
            "proposed": round(p.mean, 4),
            "proposed_half_width": round(p.half_width, 4),
            "improvement_pct": improvement,
            "samples": p.n,
            # Overlapping intervals mean the seeds do not separate these two,
            # and the site says so rather than reporting the difference.
            "separated": separated(b, p),
            "unit": unit,
            "label": label,
        }

    return {
        "alert_latency": compare("avg_alert_latency_ticks", "ticks", "Hazard-to-warning latency"),
        # Uplink specifically: the backhaul/cellular resource a cloud-only
        # design saturates with raw telemetry, and the one the deck's
        # bandwidth and privacy arguments are actually about.
        "message_overhead": compare("uplink_kilobytes_per_tick", "KB/tick", "Uplink overhead"),
        "availability_during_outage": compare(
            "availability_during_outage_pct", "%", "Availability during cloud outage",
            higher_is_better=True,
        ),
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
