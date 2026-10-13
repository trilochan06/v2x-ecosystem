"""Motion properties that have to hold for every vehicle on every tick.

These are expressed over whole randomised runs rather than over one scripted
case, because the defect they were written for -- a vehicle replanning
mid-segment and reappearing on an unrelated road -- only showed up when a
reroute happened to land while the vehicle was part-way down a link.
"""
from __future__ import annotations

import math
import random

from app.simulation.engine import SimulationEngine
from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid

# One tick of travel at 42 km/h across a 250 m block is about 0.047 of a
# cell, so anything beyond a quarter cell is a discontinuity, not movement.
MAX_STEP_CELLS = 0.25


def _run(ticks: int, seed: int) -> list[tuple[str, float]]:
    """Return the per-tick position deltas of every vehicle in one run."""
    random.seed(seed)
    engine = SimulationEngine()
    previous: dict[str, tuple[float, float]] = {}
    deltas: list[tuple[str, float]] = []
    for _ in range(ticks):
        engine.step()
        for vehicle in engine.vehicles.values():
            x, y = vehicle.position_xy()
            if vehicle.id in previous:
                px, py = previous[vehicle.id]
                deltas.append((vehicle.id, math.hypot(x - px, y - py)))
            previous[vehicle.id] = (x, y)
    return deltas


def test_no_vehicle_ever_jumps_position():
    for seed in (1, 7, 42):
        jumps = [(vid, d) for vid, d in _run(300, seed) if d > MAX_STEP_CELLS]
        assert jumps == [], f"seed {seed}: {len(jumps)} discontinuities, first {jumps[:3]}"


def test_rerouting_still_happens():
    """Guards against 'fixing' the jump by disabling rerouting altogether."""
    random.seed(7)
    engine = SimulationEngine()
    for _ in range(300):
        engine.step()
    assert sum(v.reroute_count for v in engine.vehicles.values()) > 0


def test_every_vehicle_keeps_a_usable_route():
    random.seed(3)
    engine = SimulationEngine()
    for _ in range(300):
        engine.step()
        for vehicle in engine.vehicles.values():
            assert len(vehicle.route) >= 2, f"{vehicle.id} has no onward route"
            assert vehicle.node == vehicle.route[0]
            assert 0.0 <= vehicle.progress < 1.0


def test_reroute_keeps_the_committed_link():
    """A vehicle part-way along a link finishes it; the new path diverges at
    the junction ahead, not under the wheels."""
    grid = CityGrid(size=5)
    v = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="4-0")
    v.route = ["0-0", "1-0", "2-0", "3-0", "4-0"]
    v.progress = 0.6
    committed = grid.segment_between("0-0", "1-0")

    v.receive_occupancy_ping(grid.segment_between("2-0", "3-0").id, occupancy=0.95, tick=5)
    assert v._maybe_reroute(tick=6) is True

    assert v.route[0] == "0-0"
    assert v.route[1] == "1-0", "the link under the vehicle must be preserved"
    assert grid.segment_between(v.route[0], v.route[1]).id == committed.id
    assert v.progress == 0.6


def test_reroute_from_a_junction_is_free_to_diverge_immediately():
    grid = CityGrid(size=5)
    v = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="4-0")
    v.route = ["0-0", "1-0", "2-0", "3-0", "4-0"]
    v.progress = 0.0

    v.receive_occupancy_ping(grid.segment_between("1-0", "2-0").id, occupancy=0.95, tick=5)
    assert v._maybe_reroute(tick=6) is True
    assert v.route[0] == "0-0"
    assert len(v.route) >= 2
