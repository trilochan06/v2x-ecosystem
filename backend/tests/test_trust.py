from app.network.corroboration import CorroborationEngine
from app.network.messages import Message, MessageType
from app.network.security import TrustRegistry, sign
from app.simulation.world import CityGrid


def make_hazard_message(sender: str, segment_id: str, key: str = "k") -> Message:
    payload = {"segment_id": segment_id, "hazard_type": "accident", "confidence": 0.8}
    return Message(type=MessageType.HAZARD_REPORT, sender_id=sender, payload=payload, signature=sign(payload, key))


def test_signature_round_trip():
    payload = {"a": 1}
    sig = sign(payload, "secret")
    from app.network.security import verify

    assert verify(payload, sig, "secret")
    assert not verify(payload, sig, "wrong-key")


def test_corroborated_reports_keep_trust_high():
    grid = CityGrid(size=3)
    seg_id = next(iter(grid.segments))
    trust = TrustRegistry()
    engine = CorroborationEngine()

    for tick in range(10):
        reports = [
            ("car-a", make_hazard_message("car-a", seg_id)),
            ("car-b", make_hazard_message("car-b", seg_id)),
        ]
        engine.process(reports, trust, grid, tick)

    assert trust.score("car-a") > 0.8
    assert trust.score("car-b") > 0.8
    assert grid.segments[seg_id].confirmed_incident is True


def test_uncorroborated_fabricator_gets_quarantined():
    grid = CityGrid(size=4)
    segment_ids = list(grid.segments)
    trust = TrustRegistry()
    engine = CorroborationEngine()

    for tick in range(20):
        # a lone malicious node reports a different, never-corroborated
        # segment every tick -- nobody else ever confirms it
        seg_id = segment_ids[tick % len(segment_ids)]
        engine.process([("malicious-1", make_hazard_message("malicious-1", seg_id))], trust, grid, tick)

    assert trust.is_trusted("malicious-1") is False
    assert trust.score("malicious-1") < 0.35


def test_single_unwitnessed_report_does_not_crash_trust():
    grid = CityGrid(size=3)
    seg_id = next(iter(grid.segments))
    trust = TrustRegistry()
    engine = CorroborationEngine()

    engine.process([("car-a", make_hazard_message("car-a", seg_id))], trust, grid, tick=0)

    # below the minimum sample size, a single unwitnessed report must not
    # be enough to tank an otherwise-good vehicle's trust
    assert trust.score("car-a") == 1.0
