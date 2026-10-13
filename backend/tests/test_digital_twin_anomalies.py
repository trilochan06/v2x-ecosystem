from app.simulation.digital_twin import SEGMENT_DRIFT_THRESHOLD, DigitalTwin
from app.simulation.world import CityGrid


def first_segment(grid: CityGrid):
    return next(iter(grid.all_segments()))


def test_a_synced_twin_in_a_quiet_city_reports_nothing():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)

    for tick in range(10):
        twin.sync(tick)

    assert twin.anomaly_count == 0
    assert twin.anomalies == []


def test_a_hazard_nobody_confirmed_is_an_unmodelled_incident():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)
    seg = first_segment(grid)

    twin.sync(0)
    seg.raise_hazard("accident", ttl=20, tick=1)
    twin.sync(2)

    kinds = [a.kind for a in twin.anomalies]
    assert kinds == ["unmodelled_incident"]
    assert twin.anomalies[0].segment_id == seg.id


def test_a_confirmation_with_no_hazard_behind_it_is_a_phantom():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)
    seg = first_segment(grid)

    twin.sync(0)
    # the network became convinced on its own -- no raise_hazard call, so
    # there is nothing physically on this road
    seg.confirm_incident(tick=1, ttl=20)
    twin.sync(2)

    assert [a.kind for a in twin.anomalies] == ["phantom_incident"]


def test_a_stale_replica_reports_occupancy_drift():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)
    seg = first_segment(grid)

    twin.sync(0)
    # traffic builds while synchronization is switched off
    seg.occupancy = SEGMENT_DRIFT_THRESHOLD + 0.2
    twin.sync(5)

    assert [a.kind for a in twin.anomalies] == ["occupancy_drift"]
    assert twin.anomalies[0].gap >= SEGMENT_DRIFT_THRESHOLD


def test_one_hazard_is_reported_once_however_long_it_lasts():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)
    seg = first_segment(grid)

    seg.raise_hazard("accident", ttl=100, tick=0)
    for tick in range(1, 30):
        twin.sync(tick)

    assert twin.anomaly_count == 1


def test_a_recurrence_after_the_road_clears_is_reported_again():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)
    seg = first_segment(grid)

    seg.raise_hazard("accident", ttl=100, tick=0)
    twin.sync(1)
    seg.clear_hazard()
    twin.sync(2)
    seg.raise_hazard("accident", ttl=100, tick=3)
    twin.sync(4)

    assert twin.anomaly_count == 2
    assert [a.kind for a in twin.anomalies] == ["unmodelled_incident"] * 2


def test_an_incident_mismatch_outranks_the_drift_it_causes():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)
    seg = first_segment(grid)

    twin.sync(0)
    # both conditions hold at once: a real unconfirmed hazard, and an
    # occupancy gap wide enough to trip the drift threshold on its own
    seg.raise_hazard("accident", ttl=20, tick=1)
    seg.occupancy = SEGMENT_DRIFT_THRESHOLD + 0.3
    twin.sync(2)

    assert [a.kind for a in twin.anomalies] == ["unmodelled_incident"]


def test_the_snapshot_carries_the_anomalies():
    grid = CityGrid(size=3)
    twin = DigitalTwin(grid)
    seg = first_segment(grid)

    seg.raise_hazard("accident", ttl=20, tick=0)
    twin.sync(1)
    snap = twin.snapshot(1)

    assert snap["anomaly_count"] == 1
    assert snap["anomalies"][0]["kind"] == "unmodelled_incident"
    # the existing figures are untouched
    assert snap["tracked_segments"] == len(twin.state)
    assert "divergence" in snap


def test_history_is_bounded_while_the_count_keeps_rising():
    grid = CityGrid(size=6)
    twin = DigitalTwin(grid)
    segments = list(grid.all_segments())

    tick = 0
    for seg in segments:
        seg.raise_hazard("accident", ttl=5, tick=tick)
        tick += 1
        twin.sync(tick)
        seg.clear_hazard()
        tick += 1
        twin.sync(tick)

    assert twin.anomaly_count == len(segments)
    assert len(twin.anomalies) <= 60
