"""SPaT broadcast and the SREM/SSEM priority exchange (TS 103 301).

The interesting property is that priority is *requested over a radio*, so it
can fail. A direct method call cannot, which is why the corridor used to look
perfectly reliable.
"""
from app.config import EXP1_CENTRALIZED, EXP3_FULL
from app.network.messages import MESSAGE_SPECS, Bearer, MessageType, SignalRequestStatus
from app.simulation.engine import SimulationEngine


def run(ticks: int, ambulances: int = 0, seed: int = 7, config=EXP3_FULL) -> SimulationEngine:
    engine = SimulationEngine(seed=seed, config=config)
    for _ in range(ambulances):
        engine.spawn_vehicle("ambulance")
    for _ in range(ticks):
        engine.step()
    return engine


# ------------------------------------------------------------------- SPaT
def test_intersections_broadcast_their_phase():
    engine = run(40)
    assert engine.metrics.summary()["communication"]["frames_by_designator"]["SPATEM"] > 0


def test_spat_is_never_relayed():
    """SPaT describes one junction; forwarding it two streets away is noise."""
    from app.simulation.engine import SPAT_BROADCAST_INTERVAL_TICKS

    assert SPAT_BROADCAST_INTERVAL_TICKS >= 1
    engine = SimulationEngine(seed=3)
    engine.step()
    # The frames the engine builds for lights carry ttl=1.
    frames = [f for f in engine.corridor_mgr.pending_frames if f.type == MessageType.SPATEM]
    assert all(f.ttl == 1 for f in frames)


def test_a_dead_rsu_silences_its_intersection():
    """The roadside radio transmits SPaT. No radio, no SPaT."""
    engine = SimulationEngine(seed=5)
    for rsu_id in engine.rsus:
        engine.toggle_rsu(rsu_id, False)
    before = engine.metrics.summary()["communication"]["frames_by_designator"].get("SPATEM", 0)
    for _ in range(20):
        engine.step()
    after = engine.metrics.summary()["communication"]["frames_by_designator"].get("SPATEM", 0)
    assert after == before


def test_centralized_baseline_has_no_sidelink_so_no_spat():
    engine = run(40, config=EXP1_CENTRALIZED)
    frames = engine.metrics.summary()["communication"]["frames_by_designator"]
    assert "SPATEM" not in frames


# -------------------------------------------------------------- SREM/SSEM
def test_priority_is_requested_and_sometimes_granted():
    engine = run(200, ambulances=3)
    stats = engine.signal_requests

    assert stats["requested"] > 0
    assert stats["granted"] > 0
    assert stats["requested"] == stats["granted"] + stats["unheard"]


def test_some_requests_are_never_heard():
    """The headline property: priority over a lossy radio is not guaranteed.

    If this ever becomes 0 the exchange has silently gone back to being a
    function call in disguise."""
    engine = run(200, ambulances=3)
    assert engine.signal_requests["unheard"] > 0


def test_granting_emits_an_ssem_and_preempts():
    engine = run(200, ambulances=3)
    frames = engine.metrics.summary()["communication"]["frames_by_designator"]

    assert frames["SREM"] == engine.signal_requests["requested"]
    assert frames["SSEM"] == engine.signal_requests["granted"]


def test_grant_rate_is_reported_in_the_state():
    engine = run(120, ambulances=2)
    priority = engine.state_snapshot()["signal_priority"]

    assert priority["requested"] >= priority["granted"]
    assert 0 <= priority["grant_rate_pct"] <= 100


def test_no_ambulances_means_no_priority_traffic():
    engine = run(60)
    assert engine.signal_requests["requested"] == 0


# ----------------------------------------------------------------- framing
def test_signal_messages_are_standard_its_g5_frames():
    for kind in (MessageType.SPATEM, MessageType.SREM, MessageType.SSEM):
        spec = MESSAGE_SPECS[kind]
        assert spec.bearer is Bearer.ITS_G5
        assert spec.standard == "ETSI TS 103 301"
        assert spec.payload_bytes > 0


def test_request_status_vocabulary_matches_the_standard():
    assert str(SignalRequestStatus.GRANTED) == "granted"
    assert {s.value for s in SignalRequestStatus} == {
        "requested",
        "processing",
        "granted",
        "rejected",
    }
