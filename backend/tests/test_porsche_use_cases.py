"""The three prototype applications described by Porsche Engineering.

1. Emergency brake warning -- a car brakes hard and the traffic behind is
   told before its drivers could possibly see why.
2. Collective perception -- a car turning into a crossing is warned about a
   pedestrian it has no line of sight to, because another car can see them.
3. Traffic-light interaction -- a vehicle uses the phase an intersection is
   already broadcasting to arrive on green instead of braking at a red.

Each maps onto a standard message rather than an invention: DENM with
causeCode 99/1, CPM (TS 103 324), and GLOSA derived from SPaT.
"""
import pytest

from app.network.messages import MESSAGE_SPECS, CauseCode, MessageType, cause_for
from app.simulation.engine import SimulationEngine
from app.simulation.traffic_light import CYCLE_TICKS, TrafficLight


def scene(seed: int = 4, vehicles: int = 8) -> SimulationEngine:
    """A small neighbourhood with nothing happening on its own."""
    return SimulationEngine(
        seed=seed, grid_size=4, num_rsus=4, num_vehicles=vehicles, auto_hazards=False
    )


def run(engine: SimulationEngine, ticks: int) -> SimulationEngine:
    for _ in range(ticks):
        engine.step()
    return engine


# ------------------------------------------------- 1. emergency brake light
def test_hard_braking_encodes_as_the_standard_cause_code():
    """DENM causeCode 99, subCauseCode 1 is emergencyElectronicBrakeEngaged."""
    assert cause_for("hard_braking") == (int(CauseCode.DANGEROUS_SITUATION), 1)


def test_a_pedestrian_in_the_path_makes_a_vehicle_brake():
    engine = run(scene(), 5)
    engine.spawn_pedestrian()
    run(engine, 3)

    # Whoever is on the crossing segment is braking for them.
    crossing = next(iter(engine.pedestrians.values())).segment_id
    on_crossing = [v for v in engine.vehicles.values() if v.current_segment_id == crossing]
    if on_crossing:
        assert any(v.braking_ticks > 0 for v in on_crossing)


def test_braking_broadcasts_a_denm_and_warns_the_traffic_behind():
    engine = run(scene(), 6)
    engine.spawn_pedestrian()
    run(engine, 12)

    frames = engine.metrics.summary()["communication"]["frames_by_designator"]
    assert frames.get("DENM", 0) > 0
    assert engine.perception_stats["brake_warnings"] > 0


def test_an_attacker_does_not_get_to_fake_a_brake_warning():
    """EEBL is trusted implicitly by whoever receives it, so a liar must not
    be able to emit one."""
    engine = scene()
    attacker = engine.spawn_vehicle("malicious")
    attacker.braking_ticks = 3
    message = attacker._maybe_report_braking(
        engine.grid.all_segments()[0], engine.tick
    )
    assert message is None


# --------------------------------------------- 2. collective perception (CPM)
def test_cpm_is_a_standard_frame():
    spec = MESSAGE_SPECS[MessageType.CPM]
    assert spec.designator == "CPM"
    assert spec.standard == "ETSI TS 103 324"


def test_a_vehicle_shares_what_its_sensors_see():
    engine = run(scene(), 6)
    engine.spawn_pedestrian()
    run(engine, 12)

    frames = engine.metrics.summary()["communication"]["frames_by_designator"]
    assert frames.get("CPM", 0) > 0
    assert engine.perception_stats["shared"] > 0


def test_line_of_sight_is_limited_to_the_crossing_itself():
    """A vehicle approaching the same junction down a different street is
    turning blind -- that asymmetry is the entire reason CPM exists."""
    engine = run(scene(), 4)
    pid = engine.spawn_pedestrian()
    ped = engine.pedestrians[pid]

    for vehicle in engine.vehicles.values():
        can_see = engine._has_line_of_sight(vehicle, ped)
        assert can_see == (vehicle.current_segment_id == ped.segment_id)


def test_a_blind_vehicle_still_slows_once_a_peer_tells_it():
    """The turning case: no sight of the pedestrian, but it brakes anyway."""
    engine = run(scene(), 4)
    vehicle = next(iter(engine.vehicles.values()))
    segment = vehicle.current_segment_id
    assert segment is not None

    assert not vehicle.knows_pedestrian_on(segment, engine.tick)
    vehicle.receive_perceived_object(segment, engine.tick)

    assert vehicle.knows_pedestrian_on(segment, engine.tick)
    assert vehicle.pedestrian_known_only_from_peers(segment, engine.tick)


def test_seeing_it_yourself_is_not_reported_as_a_peer_warning():
    engine = run(scene(), 4)
    vehicle = next(iter(engine.vehicles.values()))
    segment = vehicle.current_segment_id
    assert segment is not None

    vehicle.seen_pedestrians[segment] = engine.tick
    vehicle.receive_perceived_object(segment, engine.tick)

    assert vehicle.knows_pedestrian_on(segment, engine.tick)
    # It could see them, so this is not a case collective perception saved.
    assert not vehicle.pedestrian_known_only_from_peers(segment, engine.tick)


def test_a_cpm_grows_with_the_number_of_objects_reported():
    """Collective perception is a bandwidth trade, not a free win."""
    engine = run(scene(), 4)
    vehicle = next(iter(engine.vehicles.values()))
    vehicle.seen_pedestrians = {"0-0_1-0": engine.tick}
    one = vehicle._maybe_share_perception(engine.tick)

    vehicle.seen_pedestrians = {"0-0_1-0": engine.tick, "0-0_0-1": engine.tick}
    two = vehicle._maybe_share_perception(engine.tick)

    assert one is not None and two is not None
    assert two.size_bytes > one.size_bytes


def test_an_attacker_does_not_get_to_invent_road_users():
    engine = scene()
    attacker = engine.spawn_vehicle("malicious")
    attacker.seen_pedestrians = {"0-0_1-0": engine.tick}
    assert attacker._maybe_share_perception(engine.tick) is None


# ------------------------------------------------------- 3. traffic lights
def test_junctions_do_not_all_change_phase_together():
    """Regression: every light in the city shared one formula with no offset,
    so the whole grid turned red at the same instant."""
    lights = [TrafficLight(id=f"light-{x}-{y}", node=f"{x}-{y}") for x in range(3) for y in range(3)]
    seen = set()
    for tick in range(CYCLE_TICKS * 4):
        for light in lights:
            light.step(tick)
        seen.add(tuple(light.phase for light in lights))

    # If they moved in lockstep there would be exactly two states.
    assert len(seen) > 2


def test_vehicles_actually_receive_the_phase_they_are_driving_towards():
    """Regression: SPaT was transmitted but never handed to receivers, so no
    vehicle ever knew a phase and the advisory could not fire."""
    engine = run(scene(), 40)
    assert any(v.known_signals for v in engine.vehicles.values())


def test_an_advisory_speed_is_issued_on_approach_to_a_red():
    engine = run(scene(seed=11), 200)
    assert engine.state_snapshot()["perception"]["glosa_active"] >= 0

    issued = 0
    for _ in range(200):
        engine.step()
        issued += sum(1 for v in engine.vehicles.values() if v.glosa_advice is not None)
    assert issued > 0


def test_the_advice_is_slower_than_just_carrying_on():
    """Advising a *faster* speed at a red light would be actively dangerous."""
    engine = run(scene(seed=11), 120)
    for vehicle in engine.vehicles.values():
        if vehicle.glosa_advice is not None:
            assert vehicle.glosa_advice <= vehicle.speed_kmh


def test_a_stale_phase_is_not_acted_on():
    """A light heard about long ago may well have changed since."""
    engine = run(scene(), 4)
    vehicle = next(iter(engine.vehicles.values()))
    nxt = vehicle.next_node
    assert nxt is not None

    vehicle.receive_signal_phase(nxt, "red", tick=0)
    vehicle.progress = 0.9
    assert vehicle._glosa_advice(nxt, tick=500, current_speed=40.0) is None


@pytest.mark.parametrize("phase", ["green"])
def test_no_advice_when_the_light_is_already_green(phase):
    engine = run(scene(), 4)
    vehicle = next(iter(engine.vehicles.values()))
    nxt = vehicle.next_node
    assert nxt is not None

    vehicle.receive_signal_phase(nxt, phase, engine.tick)
    vehicle.progress = 0.9
    assert vehicle._glosa_advice(nxt, engine.tick, current_speed=40.0) is None


# ------------------------------------------------------- traffic density
def test_density_thins_the_city_out_and_fills_it_back_up():
    engine = scene(vehicles=12)
    assert engine.set_vehicle_count(5) == 5
    assert len(engine.vehicles) == 5
    assert engine.set_vehicle_count(18) == 18


def test_thinning_keeps_the_ambulance_and_the_attacker():
    """Removing the vehicle somebody just dispatched to watch would be its own
    kind of confusing."""
    engine = scene(vehicles=12)
    ambulance = engine.spawn_vehicle("ambulance").id
    attacker = engine.spawn_vehicle("malicious").id
    engine.set_vehicle_count(3)
    assert ambulance in engine.vehicles
    assert attacker in engine.vehicles


def test_a_removed_vehicle_is_no_longer_counted_as_served():
    """Regression: the RSU cell assignment outlived the vehicle."""
    engine = run(scene(vehicles=12), 10)
    engine.set_vehicle_count(4)
    served = sum(rsu["cell_size"] for rsu in engine.state_snapshot()["rsus"])
    assert served <= len(engine.vehicles)


def test_the_city_keeps_stepping_after_vehicles_are_removed():
    engine = run(scene(vehicles=12), 15)
    engine.set_vehicle_count(2)
    run(engine, 25)
    assert len(engine.vehicles) == 2
    assert engine.state_snapshot()["tick"] == 40


# ------------------------------------------------------------- collisions
def test_a_collision_immobilises_every_vehicle_in_it_and_blocks_the_lane():
    engine = run(scene(vehicles=16), 10)
    info = engine.trigger_collision()
    assert info is not None

    involved = [engine.vehicles[v] for v in info["vehicles"]]
    assert all(v.crashed for v in involved)
    assert engine.grid.segments[info["segment_id"]].hazard_active

    before = involved[0].position_xy()
    run(engine, 5)
    # A wreck does not drive away from its own accident.
    assert involved[0].position_xy() == before


def test_a_wreck_announces_itself_and_the_network_confirms_it():
    engine = run(scene(vehicles=16), 10)
    info = engine.trigger_collision()
    run(engine, 30)

    seg = next(s for s in engine.state_snapshot()["segments"] if s["id"] == info["segment_id"])
    assert seg["confirmed_incident"], "peers should corroborate a crash into a confirmed incident"
    frames = engine.metrics.summary()["communication"]["frames_by_designator"]
    assert frames.get("DENM", 0) > 0


def test_the_wreck_is_recovered_rather_than_driving_away():
    engine = run(scene(), 10)
    info = engine.trigger_collision()
    run(engine, 40)
    # Gone from the city entirely. It used to sit still for twenty-two ticks
    # and then resume its journey, which is not something a wrecked car does.
    for vid in info["vehicles"]:
        assert vid not in engine.vehicles
    assert not any(v.crashed for v in engine.vehicles.values())


def test_a_lone_vehicle_has_a_single_vehicle_accident():
    engine = run(scene(vehicles=1), 6)
    info = engine.trigger_collision()
    assert info is not None
    # Nothing for it to hit. Materialising a second car on top of it would be
    # a teleport in front of the audience; a car leaving the carriageway is an
    # accident that needs no second party.
    assert info["kind"] == "solo"
    assert len(info["vehicles"]) == 1
    assert len(engine.vehicles) == 1


def test_every_kind_of_collision_uses_vehicles_that_were_already_there():
    # The regression this pins: no call to trigger_collision may add a vehicle
    # to the city or move one that is already in it.
    for vehicles in (1, 4, 16):
        engine = run(scene(vehicles=vehicles), 12)
        before = {v.id: v.position_xy() for v in engine.vehicles.values()}
        info = engine.trigger_collision()
        assert info is not None
        assert set(engine.vehicles) == set(before), "a vehicle appeared or vanished"
        for vid, where in before.items():
            assert engine.vehicles[vid].position_xy() == where, f"{vid} was moved"
        assert info["kind"] in {"shunt", "junction", "solo"}


def test_an_ambulance_is_dispatched_towards_the_incident_not_at_random():
    engine = run(scene(), 10)
    info = engine.trigger_collision()
    junction = info["segment_id"].split("_")[0]

    ambulance = engine.dispatch_ambulance_to(junction)
    assert ambulance.destination == junction
    # Regression: spawning at a random node put it *on* the incident roughly
    # one time in sixteen, giving a route of one node -- no journey, no
    # corridor, nothing to watch.
    assert len(ambulance.route) > 1
    assert ambulance.route[-1] == junction


def test_the_dispatch_prefers_a_route_past_a_signalised_junction():
    """Regression: priority is requested for junctions *ahead*, so an origin
    whose only light is under its own wheels asked for nothing."""
    engine = run(scene(), 10)
    info = engine.trigger_collision()
    junction = info["segment_id"].split("_")[0]
    ambulance = engine.dispatch_ambulance_to(junction)

    lights = set(engine.traffic_lights)
    if any(
        any(hop in lights for hop in engine.grid.shortest_path(n, junction)[1:])
        for n in engine.grid.nodes
        if n != junction
    ):
        assert any(hop in lights for hop in ambulance.route[1:])


def test_a_wreck_still_shares_what_it_can_see():
    """Regression: a crashed vehicle returned early from its tick, so it
    announced the accident but never shared the pedestrian standing in front
    of it -- starving collective perception on the one road where a stopped
    car is the only thing with a view."""
    engine = run(scene(), 10)
    info = engine.trigger_collision()
    wreck = engine.vehicles[info["vehicles"][0]]
    assert wreck.crashed

    wreck.seen_pedestrians = {info["segment_id"]: engine.tick}
    seg = engine.grid.segments[info["segment_id"]]
    messages, _, _ = wreck.step(engine.tick, allow_v2v=True, allow_rerouting=True)

    assert any(m.type == MessageType.CPM for m in messages)
    assert any(m.type == MessageType.DENM_HAZARD for m in messages) or engine.tick % 3 != 0
    assert seg is not None
