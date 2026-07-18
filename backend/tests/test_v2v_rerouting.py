from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid


def test_vehicle_reroutes_around_peer_reported_congestion():
    grid = CityGrid(size=4)
    v = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="3-0")
    v.route = ["0-0", "1-0", "2-0", "3-0"]

    blocked_segment = grid.segment_between("1-0", "2-0")
    v.receive_occupancy_ping(blocked_segment.id, occupancy=0.95, tick=5)

    rerouted = v._maybe_reroute(tick=6)

    assert rerouted is True
    assert blocked_segment.id not in {
        grid.segment_between(v.route[i], v.route[i + 1]).id for i in range(len(v.route) - 1)
    }


def test_vehicle_does_not_reroute_on_stale_peer_info():
    grid = CityGrid(size=4)
    v = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="3-0")
    v.route = ["0-0", "1-0", "2-0", "3-0"]

    blocked_segment = grid.segment_between("1-0", "2-0")
    v.receive_occupancy_ping(blocked_segment.id, occupancy=0.95, tick=0)

    rerouted = v._maybe_reroute(tick=100)  # way past PEER_INFO_STALE_TICKS

    assert rerouted is False
    assert v.route == ["0-0", "1-0", "2-0", "3-0"]


def test_ambulance_never_reroutes_off_priority_path():
    grid = CityGrid(size=4)
    v = Vehicle(id="amb-1", kind="ambulance", grid=grid, node="0-0", destination="3-0")
    v.route = ["0-0", "1-0", "2-0", "3-0"]

    blocked_segment = grid.segment_between("1-0", "2-0")
    v.receive_occupancy_ping(blocked_segment.id, occupancy=0.99, tick=5)

    rerouted = v._maybe_reroute(tick=6)

    assert rerouted is False
    assert v.route == ["0-0", "1-0", "2-0", "3-0"]


def test_reroute_respects_cooldown():
    grid = CityGrid(size=5)
    v = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="4-0")
    v.route = ["0-0", "1-0", "2-0", "3-0", "4-0"]

    seg1 = grid.segment_between("1-0", "2-0")
    v.receive_occupancy_ping(seg1.id, occupancy=0.95, tick=5)
    assert v._maybe_reroute(tick=6) is True

    cooldown_snapshot = v._reroute_cooldown_until
    seg_after = grid.segment_between(v.route[1], v.route[2])
    v.receive_occupancy_ping(seg_after.id, occupancy=0.95, tick=7)

    # still inside the cooldown window -- should not thrash on every tick
    assert v._maybe_reroute(tick=cooldown_snapshot - 1) is False
