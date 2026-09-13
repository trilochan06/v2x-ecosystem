from app.network.pseudonyms import PseudonymAuthority, ReplayGuard


def test_certificates_rotate_when_they_expire():
    authority = PseudonymAuthority(lifetime_ticks=10)
    first = authority.enroll("car-1", tick=0)

    still_valid = authority.certificate_for("car-1", tick=5)
    assert still_valid.pseudonym == first.pseudonym

    rotated = authority.certificate_for("car-1", tick=20)
    assert rotated.pseudonym != first.pseudonym
    assert authority.rotation_count == 1


def test_rsu_can_verify_but_not_link_pseudonyms():
    """An RSU learns that a pseudonym is validly issued and nothing more --
    that separation is what stops roadside tracking."""
    authority = PseudonymAuthority(lifetime_ticks=10)
    first = authority.enroll("car-1", tick=0)
    second = authority.certificate_for("car-1", tick=20)

    assert authority.verify(second.pseudonym, tick=21) is True
    # The retired pseudonym no longer validates, so the two cannot be tied
    # together by an observer replaying old frames.
    assert authority.verify(first.pseudonym, tick=21) is False
    # Only the authority holds the mapping.
    assert authority.resolve(second.pseudonym) == "car-1"


def test_revoked_vehicle_fails_verification_under_any_pseudonym():
    authority = PseudonymAuthority(lifetime_ticks=50)
    cert = authority.enroll("attacker", tick=0)
    assert authority.verify(cert.pseudonym, tick=1) is True

    authority.revoke("attacker")

    assert authority.verify(cert.pseudonym, tick=2) is False
    rotated = authority.certificate_for("attacker", tick=100)
    assert authority.verify(rotated.pseudonym, tick=101) is False


def test_rotation_count_tracks_privacy_budget():
    authority = PseudonymAuthority(lifetime_ticks=5)
    authority.enroll("car-1", tick=0)
    for tick in (6, 12, 18):
        authority.rotate_expired(["car-1"], tick=tick)

    assert authority.pseudonyms_issued_to("car-1") == 4
    snapshot = authority.snapshot(vehicle_count=1)
    assert snapshot["rotations"] == 3


def test_replay_guard_rejects_stale_frames():
    guard = ReplayGuard(freshness_window=5)
    assert guard.accept("rsu-1", "msg-1", created_tick=0, now=50) is False
    assert guard.stale_dropped == 1


def test_replay_guard_rejects_repeat_at_same_receiver():
    guard = ReplayGuard(freshness_window=5)
    assert guard.accept("rsu-1", "msg-1", created_tick=10, now=10) is True
    assert guard.accept("rsu-1", "msg-1", created_tick=10, now=11) is False
    assert guard.replays_blocked == 1


def test_same_frame_at_different_receivers_is_not_a_replay():
    """A broadcast legitimately reaches many nodes at once. Counting those
    as replays was a real bug -- it reported a 90% rejection rate on a
    perfectly healthy network."""
    guard = ReplayGuard(freshness_window=5)

    assert guard.accept("rsu-1", "msg-1", created_tick=10, now=10) is True
    assert guard.accept("rsu-2", "msg-1", created_tick=10, now=10) is True
    assert guard.accept("car-9", "msg-1", created_tick=10, now=10) is True

    assert guard.replays_blocked == 0
    assert guard.accepted == 3


def test_guard_prunes_expired_nonces():
    guard = ReplayGuard(freshness_window=2)
    guard.accept("rsu-1", "msg-1", created_tick=0, now=0)
    guard.prune(now=100)
    assert guard._seen == {}
