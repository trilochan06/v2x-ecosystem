"""The twin has to be a replica with a known age and a known error, not a
second name for the live grid."""
from __future__ import annotations

import random

from app.simulation.engine import SimulationEngine
from app.simulation.twin import SEGMENT_ANOMALY_THRESHOLD, TransportDigitalTwin
from app.simulation.world import CityGrid


def test_replica_is_a_copy_not_a_reference():
    grid = CityGrid(size=4)
    twin = TransportDigitalTwin()
    seg = grid.all_segments()[0]
    seg.occupancy = 0.2
    twin.sync(grid, tick=0)

    seg.occupancy = 0.9  # the world moves on; the replica must not follow
    assert twin.segments[seg.id].occupancy == 0.2


def test_staleness_grows_between_syncs():
    grid = CityGrid(size=4)
    twin = TransportDigitalTwin()
    twin.sync(grid, tick=10)
    assert twin.staleness(10) == 0
    assert twin.staleness(17) == 7


def test_divergence_is_measured_against_physical_state():
    grid = CityGrid(size=4)
    twin = TransportDigitalTwin()
    twin.sync(grid, tick=0)

    for seg in grid.all_segments():
        seg.occupancy = 0.5
    twin.sync(grid, tick=2)  # measures the old replica before replacing it

    assert twin.divergence > 0.4
    assert twin.alert is True


def test_unreported_hazard_surfaces_as_an_anomaly():
    """A real hazard the network never confirmed is exactly what the
    divergence detector exists to surface."""
    grid = CityGrid(size=4)
    twin = TransportDigitalTwin()
    twin.sync(grid, tick=0)

    seg = grid.all_segments()[0]
    seg.incident = True  # physically present
    seg.reported_incident = False  # nobody corroborated it
    twin.sync(grid, tick=2)

    kinds = {a.kind for a in twin.anomalies if a.segment_id == seg.id}
    assert "unmodelled_incident" in kinds


def test_confirmed_fabrication_surfaces_as_a_phantom():
    grid = CityGrid(size=4)
    twin = TransportDigitalTwin()
    seg = grid.all_segments()[0]
    seg.reported_incident = True  # the network believes it
    twin.sync(grid, tick=0)

    seg.incident = False  # it was never real
    twin.sync(grid, tick=2)

    kinds = {a.kind for a in twin.anomalies if a.segment_id == seg.id}
    assert "phantom_incident" in kinds


def test_query_reports_the_age_of_its_own_answer():
    grid = CityGrid(size=4)
    twin = TransportDigitalTwin()
    twin.sync(grid, tick=4)
    seg_id = grid.all_segments()[0].id

    answer = twin.query(seg_id, tick=9)
    assert answer is not None
    assert answer["as_of_tick"] == 4
    assert answer["staleness_ticks"] == 5
    assert twin.query("no-such-segment", tick=9) is None


def test_twin_syncs_while_the_engine_runs():
    random.seed(4)
    engine = SimulationEngine()
    for _ in range(40):
        engine.step()

    state = engine.state_snapshot()["digital_twin"]
    assert state["syncs"] > 0
    assert state["replica_segments"] == len(engine.grid.all_segments())
    assert state["staleness_ticks"] <= state["sync_interval"]
    assert 0.0 <= state["divergence"] <= 1.0


def test_anomaly_threshold_is_not_trivially_tripped():
    grid = CityGrid(size=4)
    twin = TransportDigitalTwin()
    twin.sync(grid, tick=0)
    for seg in grid.all_segments():
        seg.occupancy = SEGMENT_ANOMALY_THRESHOLD / 2
    twin.sync(grid, tick=2)
    drift = [a for a in twin.anomalies if a.kind == "occupancy_drift"]
    assert drift == []
