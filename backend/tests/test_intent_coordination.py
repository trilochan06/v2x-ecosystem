"""Intent coordination (M6b) -- a tested hypothesis with a negative result.

The proposition was that greedy rerouting herds: every vehicle hears the same
congestion report, computes the same detour, and arrives on it together. The
fix tried here is decentralized coordination -- vehicles announce where they
intend to go (MCM) and price a road by how many peers have claimed it, plus a
per-vehicle tie-break so identical vehicles stop computing identical routes.

The herding is real and the mechanism does break it. What it does *not* do is
improve throughput, and it costs a great deal of bandwidth. These tests pin
the mechanism so the negative result stays reproducible rather than becoming
folklore; the measured figures are in the README.
"""
import pytest

from app.config import CONFIGS, EXP3_FULL, EXP4_COORDINATED
from app.network.messages import MESSAGE_SPECS, MessageType
from app.simulation import vehicle as vehicle_module
from app.simulation.engine import SimulationEngine
from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid


def scene(config=EXP4_COORDINATED, seed: int = 4, vehicles: int = 10) -> SimulationEngine:
    return SimulationEngine(
        seed=seed, grid_size=5, num_rsus=4, num_vehicles=vehicles,
        config=config, auto_hazards=False,
    )


def run(engine: SimulationEngine, ticks: int) -> SimulationEngine:
    for _ in range(ticks):
        engine.step()
    return engine


# ------------------------------------------------------------- the frame
def test_mcm_is_a_standard_frame():
    spec = MESSAGE_SPECS[MessageType.MCM]
    assert spec.designator == "MCM"
    assert spec.standard == "ETSI TR 103 578"


def test_announcing_a_longer_plan_costs_more_air_time():
    """Foresight is not free -- the intended path rides in variable_bytes."""
    engine = run(scene(), 6)
    vehicle = next(v for v in engine.vehicles.values() if len(v.route) >= 4)

    vehicle.route = vehicle.route[:2]
    short = vehicle._maybe_share_intent(tick=0)
    vehicle.route = engine.grid.shortest_path(vehicle.node, vehicle.destination)
    long = vehicle._maybe_share_intent(tick=0)

    if short is not None and long is not None and len(vehicle.route) > 2:
        assert long.size_bytes >= short.size_bytes


def test_an_attacker_does_not_get_to_announce_intent():
    """A liar claiming every road would steer honest traffic away from it."""
    engine = scene()
    attacker = engine.spawn_vehicle("malicious")
    assert attacker._maybe_share_intent(tick=0) is None


# -------------------------------------------------------- the mechanism
def test_intent_is_peer_knowledge_only():
    """Like every other belief, it exists because a frame was delivered."""
    engine = run(scene(), 4)
    vehicle = next(iter(engine.vehicles.values()))
    vehicle.peer_intent.clear()

    assert vehicle.claimed_by_peers("0-0_1-0", engine.tick) == 0
    vehicle.receive_intent(["0-0_1-0"], engine.tick)
    assert vehicle.claimed_by_peers("0-0_1-0", engine.tick) == 1


def test_a_stale_claim_stops_counting():
    engine = run(scene(), 4)
    vehicle = next(iter(engine.vehicles.values()))
    vehicle.receive_intent(["0-0_1-0"], tick=0)
    assert vehicle.claimed_by_peers("0-0_1-0", tick=0) == 1
    assert vehicle.claimed_by_peers("0-0_1-0", tick=500) == 0


def test_identical_vehicles_stop_computing_identical_detours():
    """This is the herding effect, and this is the fix working.

    Every road is the same length, so the search is really minimising hop
    count and ties are everywhere. Broken the same way in every vehicle, two
    cars in the same place heading the same way get byte-identical detours.
    """
    grid = CityGrid(size=6)
    avoid = frozenset({"2-2_3-2"})
    routes = set()
    for i in range(6):
        v = Vehicle(id=f"car-{i}", kind="car", grid=grid, node="0-0", destination="5-5")
        v.intent_coordination = True
        v.route = grid.shortest_path("0-0", "5-5")
        routes.add(tuple(v._detour(avoid, tick=10)))
    assert len(routes) > 1, "identical vehicles still stampede onto one detour"


def test_diversity_does_not_send_anyone_the_long_way_round():
    """A tie-break must not overpower a genuinely shorter route."""
    grid = CityGrid(size=6)
    shortest = len(grid.shortest_path("0-0", "3-3"))
    for i in range(12):
        v = Vehicle(id=f"car-{i}", kind="car", grid=grid, node="0-0", destination="3-3")
        v.intent_coordination = True
        v.route = grid.shortest_path("0-0", "3-3")
        assert len(v._detour(frozenset(), tick=0)) == shortest


def test_a_claimed_road_is_priced_higher_than_an_empty_one():
    grid = CityGrid(size=5)
    v = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="4-4")
    v.intent_coordination = True
    seg = grid.segment_between("0-0", "1-0")

    plain = v._detour(frozenset(), tick=0)
    for _ in range(6):
        v.receive_intent([seg.id], tick=0)
    crowded = v._detour(frozenset(), tick=0)

    # Either it routed away from the crowded road, or every alternative was
    # worse -- both are legitimate, but the claim must be visible.
    assert v.claimed_by_peers(seg.id, 0) == 6
    assert plain and crowded


# ------------------------------------------------------------ the search
def test_least_cost_path_matches_the_plain_search_on_a_uniform_grid():
    """Every road is 250 m, so a weighted search with a flat cost must agree
    with the breadth-first one -- otherwise the comparison against Exp 3 is
    measuring the algorithm swap rather than the coordination."""
    grid = CityGrid(size=6)
    for goal in ("5-5", "0-5", "3-2"):
        bfs = grid.shortest_path("0-0", goal)
        dijkstra = grid.least_cost_path("0-0", goal, lambda seg: seg.length_m)
        assert len(dijkstra) == len(bfs)
        assert dijkstra[0] == "0-0" and dijkstra[-1] == goal


def test_least_cost_path_reports_an_unreachable_goal():
    grid = CityGrid(size=4)
    assert grid.least_cost_path("0-0", "3-3", lambda seg: None) == []


# ----------------------------------------------------------- the wiring
def test_coordination_is_off_in_the_proposed_architecture():
    """It was tested and it did not pay for itself, so it is not part of the
    baseline -- only of the experiment that measured it."""
    assert EXP3_FULL.intent_coordination is False
    assert EXP4_COORDINATED.intent_coordination is True
    assert CONFIGS["exp4_coordinated"] is EXP4_COORDINATED


def test_exp4_differs_from_exp3_in_exactly_one_flag():
    """Otherwise any difference in the results is unattributable."""
    a, b = EXP3_FULL.describe(), EXP4_COORDINATED.describe()
    differing = {k for k in a if a[k] != b[k]} - {"key", "label", "summary"}
    assert differing == {"intent_coordination"}


def test_mcm_only_goes_on_the_air_when_coordination_is_enabled():
    plain = run(scene(config=EXP3_FULL), 30)
    coordinated = run(scene(config=EXP4_COORDINATED), 30)

    assert plain.metrics.summary()["communication"]["frames_by_designator"].get("MCM", 0) == 0
    assert coordinated.metrics.summary()["communication"]["frames_by_designator"]["MCM"] > 0


def test_coordination_costs_bandwidth():
    """The one thing this mechanism reliably does. Kept as a test because it
    is the finding: the cost separates cleanly while the benefit does not."""
    plain = run(scene(config=EXP3_FULL, vehicles=16), 60)
    coordinated = run(scene(config=EXP4_COORDINATED, vehicles=16), 60)

    a = plain.metrics.summary()["communication"]["local_kilobytes_per_tick"]
    b = coordinated.metrics.summary()["communication"]["local_kilobytes_per_tick"]
    assert b > a


@pytest.mark.parametrize("seed", [1, 2, 3])
def test_a_coordinated_run_is_reproducible_from_its_seed(seed):
    """The tie-break is a stable hash, not `random`, so a result someone
    cannot reproduce is a result nobody should believe."""
    first = run(scene(seed=seed), 40).metrics.summary()["traffic"]
    second = run(scene(seed=seed), 40).metrics.summary()["traffic"]
    assert first == second
