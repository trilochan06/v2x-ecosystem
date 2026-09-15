"""Vehicle motion -- the part of the simulation an audience watches directly.

Every other suite here checks a number. These check that the picture is not
lying: that a car goes where a car can go, that it does not cross the city
between two frames, and that a wreck stays wrecked. A metric can be right while
the map is nonsense, and the map is what an audience sees.

The mirror of these lives in `frontend/src/sim/motion.test.ts`, because the
hosted site runs the TypeScript port and a bug fixed in one engine that stays
in the other is a bug that ships.
"""
from __future__ import annotations

import math

from app.simulation.engine import SimulationEngine
from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid

#: The furthest anything may legitimately move in one tick.
#:
#: A segment is 250 m and the fastest vehicle is an ambulance; even at its top
#: speed that is a fraction of one grid unit per tick. One whole unit means the
#: vehicle changed which road it was on without driving along it.
MAX_STEP = 1.0


def scene(seed: int = 7, vehicles: int = 14) -> SimulationEngine:
    return SimulationEngine(seed=seed, grid_size=6, num_rsus=4, num_vehicles=vehicles)


def run(engine: SimulationEngine, ticks: int) -> SimulationEngine:
    for _ in range(ticks):
        engine.step()
    return engine


def _dist(a: tuple[float, float], b: tuple[float, float]) -> float:
    return math.hypot(a[0] - b[0], a[1] - b[1])


# ------------------------------------------------------------- continuity
def test_no_vehicle_jumps_further_in_a_tick_than_it_could_have_driven():
    engine = scene()
    previous = {v.id: v.position_xy() for v in engine.vehicles.values()}

    jumps = []
    for _ in range(400):
        engine.step()
        for vehicle in engine.vehicles.values():
            was = previous.get(vehicle.id)
            # A vehicle that has only just entered the city has no previous
            # position to be continuous with.
            if was is None:
                continue
            moved = _dist(was, vehicle.position_xy())
            if moved > MAX_STEP:
                jumps.append(f"{vehicle.id} moved {moved:.2f} units at tick {engine.tick}")
        previous = {v.id: v.position_xy() for v in engine.vehicles.values()}

    assert jumps == []


def test_every_vehicle_sits_on_a_road_that_exists():
    engine = scene()
    off_road = []

    for _ in range(300):
        engine.step()
        for vehicle in engine.vehicles.values():
            nxt = vehicle.next_node
            if nxt is None:
                continue
            assert vehicle.grid.segment_between(vehicle.node, nxt) is not None
            here = vehicle.position_xy()
            a = engine.grid.coords(vehicle.node)
            b = engine.grid.coords(nxt)
            along = _dist(a, here) + _dist(here, b)
            if along > _dist(a, b) + 1e-9:
                off_road.append(f"{vehicle.id} is off the line between {vehicle.node} and {nxt}")

    assert off_road == []


def test_a_vehicle_finishes_the_road_it_is_on_before_taking_a_different_one():
    """The rule that makes the two tests above hold.

    A vehicle may change its mind about the rest of the route at any time; it
    may not change its mind about the link it is halfway down. Replanning from
    `node` while `progress` is non-zero puts the car that fraction of the way
    along whatever road the new route starts with -- which is the teleporting.
    """
    engine = scene()
    committed: dict[str, tuple[str, float]] = {}
    broken = []

    for _ in range(400):
        engine.step()
        for vehicle in engine.vehicles.values():
            seg = vehicle.current_segment_id
            was = committed.get(vehicle.id)
            if was and seg and seg != was[0] and was[1] > 0 and vehicle.progress > 0:
                broken.append(f"{vehicle.id} abandoned {was[0]} at {was[1]:.2f} for {seg}")
            if seg:
                committed[vehicle.id] = (seg, vehicle.progress)
            else:
                committed.pop(vehicle.id, None)

    assert broken == []


def test_rerouting_keeps_the_current_link_and_replans_from_the_junction_ahead():
    engine = run(scene(), 40)
    vehicle = next(
        (v for v in engine.vehicles.values() if len(v.route) >= 4 and v.progress > 0.1), None
    )
    assert vehicle is not None, "no vehicle was mid-link with a route to divert"

    before = (vehicle.node, vehicle.next_node, vehicle.progress)
    # Warn it about the road immediately after the one it is on, which is the
    # first road it can still do anything about.
    ahead = engine.grid.segment_between(vehicle.route[1], vehicle.route[2])
    vehicle.hazard_warnings[ahead.id] = engine.tick
    vehicle.reroute(engine.tick)

    assert (vehicle.node, vehicle.next_node, vehicle.progress) == before


# ------------------------------------------------------------- trip model
def test_destinations_follow_land_use_rather_than_a_uniform_draw():
    engine = scene(vehicles=24)
    chosen: list[str] = []
    seen: dict[str, str] = {}

    for _ in range(900):
        engine.step()
        for vehicle in engine.vehicles.values():
            if seen.get(vehicle.id) != vehicle.destination:
                chosen.append(vehicle.destination)
            seen[vehicle.id] = vehicle.destination

    # Trips are long -- a crossing of a six-by-six grid is most of two hundred
    # ticks -- so this is a few trips each, not a few hundred.
    assert len(chosen) > 50

    def share(use: str) -> float:
        return sum(1 for n in chosen if engine.grid.land_use(n) == use) / len(chosen)

    per_node = {
        use: share(use) / max(1, sum(1 for n in engine.grid.nodes if engine.grid.land_use(n) == use))
        for use in ("centre", "residential")
    }
    assert per_node["centre"] > per_node["residential"] * 2


def test_a_trip_ends_somewhere_instead_of_bouncing_off_its_destination():
    engine = scene()
    ever_parked = False
    for _ in range(400):
        engine.step()
        if any(v.dwell_ticks > 0 for v in engine.vehicles.values()):
            ever_parked = True
    assert ever_parked


def test_every_vehicle_can_say_why_it_is_driving_where_it_is():
    engine = run(scene(), 20)
    for state in engine.state_snapshot()["vehicles"]:
        assert state["trip_purpose"]


def test_a_parked_vehicle_does_not_transmit():
    grid = CityGrid(size=5)
    vehicle = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="4-4")
    vehicle.dwell_ticks = 3
    outbound, rerouted, completed = vehicle.step(tick=1, allow_v2v=True, allow_rerouting=True)
    assert outbound == []
    assert rerouted is False and completed is None
    assert vehicle.dwell_ticks == 2
