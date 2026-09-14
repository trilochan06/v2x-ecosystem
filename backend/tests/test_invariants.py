"""Things that must never appear in a state snapshot, under any abuse.

Unit tests check that each piece does its job. This checks that the whole
machine, driven hard — attackers, ambulances, a cloud outage and dead roadside
units, across every architecture — never emits a NaN, a negative count, a
ratio above one, or books a signal request it cannot account for.

Those are the failures that do not raise: they quietly reach a chart and get
written into a report.
"""
import math

import pytest

from app.config import CONFIGS
from app.simulation.engine import TRANSMISSION_LOG_LIMIT, SimulationEngine

RATIO_KEYS = {"packet_delivery_ratio", "precision", "recall", "f1"}
PERCENT_KEYS = {
    "availability_pct",
    "availability_during_outage_pct",
    "congestion_duration_pct",
    "rejection_rate_pct",
    "grant_rate_pct",
}


def walk(obj, path=""):
    """Every scalar in a nested structure, with the path that reached it."""
    if isinstance(obj, dict):
        for key, value in obj.items():
            yield from walk(value, f"{path}.{key}")
    elif isinstance(obj, list):
        for i, value in enumerate(obj[:5]):
            yield from walk(value, f"{path}[{i}]")
    else:
        yield path, obj


def stressed(config, seed: int, ticks: int = 220) -> SimulationEngine:
    """A run with everything going wrong at once."""
    engine = SimulationEngine(
        seed=seed, config=config, inference_interval=3, explain_predictions=False
    )
    for _ in range(3):
        engine.spawn_vehicle("malicious")
    for _ in range(2):
        engine.spawn_vehicle("ambulance")

    for tick in range(ticks):
        if tick == 50:
            for rsu_id in list(engine.rsus)[:2]:
                engine.toggle_rsu(rsu_id, False)
        if tick == 100:
            engine.set_cloud_online(False)
        if tick == 160:
            engine.set_cloud_online(True)
        engine.step()
    return engine


@pytest.mark.parametrize("config_key", sorted(CONFIGS))
def test_no_impossible_numbers_reach_the_snapshot(config_key):
    engine = stressed(CONFIGS[config_key], seed=7)
    snapshot = engine.state_snapshot()

    for path, value in walk(snapshot):
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            continue
        assert not math.isnan(value), f"{path} is NaN"
        assert not math.isinf(value), f"{path} is infinite"

        leaf = path.rsplit(".", 1)[-1]
        if leaf in RATIO_KEYS:
            assert 0.0 <= value <= 1.0, f"{path} = {value}, expected a ratio"
        if leaf in PERCENT_KEYS:
            assert 0.0 <= value <= 100.0, f"{path} = {value}, expected a percentage"


@pytest.mark.parametrize("config_key", sorted(CONFIGS))
def test_counts_are_never_negative(config_key):
    snapshot = stressed(CONFIGS[config_key], seed=11).state_snapshot()
    detection = snapshot["metrics"]["detection"]

    for key in ("true_positives", "false_positives", "hazards_detected", "hazards_missed"):
        assert detection[key] >= 0, f"{key} went negative"
    assert snapshot["metrics"]["communication"]["messages_sent"] >= 0


def test_every_priority_request_is_accounted_for():
    """Granted plus unheard must equal requested. A request that falls into
    neither bucket is a request the corridor silently lost."""
    engine = stressed(CONFIGS["exp3_full"], seed=5)
    priority = engine.signal_requests

    assert priority["requested"] == priority["granted"] + priority["unheard"]


def test_the_transmission_log_stays_bounded():
    """It ships inside every snapshot, so an unbounded log is a slow leak."""
    engine = stressed(CONFIGS["exp3_full"], seed=3, ticks=400)
    assert len(engine.transmissions) <= TRANSMISSION_LOG_LIMIT


def test_delivered_receivers_are_real_stations():
    """A transmission naming a receiver that does not exist would draw a hop
    to nowhere in the street view."""
    engine = stressed(CONFIGS["exp3_full"], seed=9)
    known = set(engine.vehicles) | set(engine.rsus)

    for frame in engine.transmissions:
        for receiver in frame["delivered_to"]:
            assert receiver in known, f"{frame['designator']} delivered to unknown {receiver}"


def test_every_transmitter_can_be_located_on_a_map():
    """Senders are vehicles, roadside units, or traffic lights. Anything else
    cannot be drawn, and the street view drops it silently."""
    engine = stressed(CONFIGS["exp3_full"], seed=13)
    nodes = set(engine.grid.nodes)

    for frame in engine.transmissions:
        sender = frame["sender_id"]
        locatable = (
            sender in engine.vehicles
            or sender in engine.rsus
            or (sender.startswith("light-") and sender[len("light-") :] in nodes)
        )
        assert locatable, f"{frame['designator']} sent by unlocatable {sender}"
