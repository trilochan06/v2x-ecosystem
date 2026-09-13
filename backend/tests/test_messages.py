"""The C-ITS frame model: standard sizes, cause codes, security envelope.

These numbers feed the message-overhead metric that the whole centralized-vs-
decentralized comparison rests on, so they are pinned here rather than left to
drift.
"""
from app.network.messages import (
    CERTIFICATE_BYTES,
    CERTIFICATE_DIGEST_BYTES,
    SIGNATURE_BYTES,
    Bearer,
    CauseCode,
    CertificateAttachmentPolicy,
    Message,
    MessageType,
    backhaul_bytes,
    cause_for,
)


def cam(**kw) -> Message:
    kw.setdefault("sender_id", "v1")
    kw.setdefault("payload", {"segment_id": "0-0_1-0"})
    return Message(type=MessageType.CAM, **kw)


def denm(**kw) -> Message:
    kw.setdefault("sender_id", "v1")
    kw.setdefault("payload", {"segment_id": "0-0_1-0"})
    return Message(type=MessageType.DENM_HAZARD, **kw)


# ------------------------------------------------------------- frame sizes
def test_signed_frames_land_in_the_sizes_the_standards_produce():
    """Exact sizes, pinned to the same numbers as the TypeScript port in
    frontend/src/sim/sim.test.ts. If either engine drifts, one suite fails."""
    # 4 ITS PDU header + 117 payload + 64 signature + 17 SignedData + 8 digest
    assert cam(signature="sig", certificate_attached=False).size_bytes == 210
    # ... and 117 for the full certificate instead of the 8-byte digest
    assert cam(signature="sig", certificate_attached=True).size_bytes == 319
    assert denm(signature="sig", certificate_attached=False).size_bytes == 273
    assert denm(signature="sig", certificate_attached=True).size_bytes == 382


def test_size_does_not_depend_on_python_repr():
    """Two DENMs differ on the air only by what they actually encode, not by
    how long their dict keys happen to be."""
    short = denm(payload={"a": 1})
    long = denm(payload={"a_very_long_key_name_indeed": "and a long value too"})

    assert short.size_bytes == long.size_bytes


def test_variable_content_adds_to_the_frame():
    plain = denm(signature="sig")
    with_path = Message(
        type=MessageType.DENM_EVA,
        sender_id="amb-1",
        payload={},
        signature="sig",
        variable_bytes=48,
    )
    assert with_path.size_bytes == plain.size_bytes + 48


# -------------------------------------------------------- security envelope
def test_unsigned_frame_pays_no_security_envelope():
    assert cam().security_bytes == 0


def test_attached_certificate_costs_more_than_a_digest():
    digest = cam(signature="sig", certificate_attached=False)
    full = cam(signature="sig", certificate_attached=True)

    assert digest.security_bytes == SIGNATURE_BYTES + 17 + CERTIFICATE_DIGEST_BYTES
    assert full.security_bytes == SIGNATURE_BYTES + 17 + CERTIFICATE_BYTES
    assert full.size_bytes - digest.size_bytes == CERTIFICATE_BYTES - CERTIFICATE_DIGEST_BYTES


def test_backhaul_traffic_does_not_pay_the_1609_2_envelope():
    """Probe data rides TLS, which already authenticates the peer. Charging it
    a certificate as well would flatter the decentralized design."""
    probe = Message(
        type=MessageType.TELEMETRY_UPLOAD,
        sender_id="v1",
        payload={"speed": 40},
        signature="sig",
    )
    assert probe.bearer is Bearer.BACKHAUL
    assert probe.security_bytes == 0
    assert probe.size_bytes == 92  # 20 framing + 72 payload


def test_uploaded_observation_is_sized_as_backhaul_not_as_a_denm():
    frame = denm(signature="sig", certificate_attached=True)
    assert backhaul_bytes(frame) == 200
    assert backhaul_bytes(frame) < frame.size_bytes


# ------------------------------------------- certificate attachment policy
def test_certificate_is_attached_periodically_not_on_every_frame():
    policy = CertificateAttachmentPolicy(interval=10)
    attached = [policy.attach("pseudo-1") for _ in range(30)]

    assert attached[0] is True
    assert attached[1:10] == [False] * 9
    assert sum(attached) == 3
    assert policy.certificates_attached == 3
    assert policy.digests_attached == 27


def test_rotating_a_pseudonym_forces_the_certificate_to_be_resent():
    """Receivers cache a certificate against the pseudonym that sent it, so
    unlinkability costs bandwidth. That trade is the point of the test."""
    policy = CertificateAttachmentPolicy(interval=10)
    policy.attach("pseudo-1")
    assert policy.attach("pseudo-1") is False

    assert policy.attach("pseudo-2") is True


def test_policy_reports_what_digests_saved():
    policy = CertificateAttachmentPolicy(interval=10)
    for _ in range(10):
        policy.attach("pseudo-1")

    assert policy.bytes_saved == 9 * (CERTIFICATE_BYTES - CERTIFICATE_DIGEST_BYTES)
    assert policy.snapshot()["frames_secured"] == 10


# -------------------------------------------------------------- cause codes
def test_hazard_labels_map_onto_the_common_data_dictionary():
    assert cause_for("accident") == (int(CauseCode.ACCIDENT), 0)
    # stationaryVehicle / vehicleBreakdown
    assert cause_for("stalled_vehicle") == (int(CauseCode.STATIONARY_VEHICLE), 2)
    # adverseWeatherCondition-Adhesion / fuelOnTheRoad
    assert cause_for("oil_spill") == (int(CauseCode.ADVERSE_WEATHER_ADHESION), 2)
    # adverseWeatherCondition-Visibility / fog
    assert cause_for("fog_bank") == (int(CauseCode.ADVERSE_WEATHER_VISIBILITY), 1)


def test_unknown_hazard_degrades_to_a_valid_cause_code():
    cause, sub = cause_for("something_the_cdd_has_never_heard_of")
    assert cause == int(CauseCode.DANGEROUS_SITUATION)
    assert sub == 0


def test_relay_preserves_the_frame_size():
    original = denm(signature="sig", ttl=3, variable_bytes=24, certificate_attached=True)
    relayed = original.relayed()

    assert relayed.ttl == 2
    assert relayed.id == original.id
    assert relayed.size_bytes == original.size_bytes
