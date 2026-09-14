"""ETSI cooperative-ITS message set, wire sizing, and the security envelope.

Real C-ITS deployments do not invent their own wire formats. The message set
is standardised so that a vehicle from one manufacturer is understood by
roadside equipment from another, and the *sizes* of those messages are what
actually drive the bandwidth and privacy results this project reports. So the
frames here are modelled on the standards rather than on an ad-hoc enum.

Implemented -- the ETSI "Day-1" service set
-------------------------------------------
CAM   EN 302 637-2  Cooperative Awareness Message. The periodic "I am here,
                    this fast, this heading" heartbeat every station emits.
DENM  EN 302 637-3  Decentralized Environmental Notification Message. Event
                    driven, and carries a CauseCode/SubCauseCode drawn from
                    the TS 102 894-2 Common Data Dictionary rather than a
                    free-text hazard label.

Also implemented -- collective perception
-----------------------------------------
CPM    TS 103 324   Collective Perception Message. A station shares what its
                    *sensors* detect, not just its own state, so a vehicle
                    whose view is blocked learns about a road user it cannot
                    see. The frame grows with every object reported, which is
                    the cost that makes collective perception a trade rather
                    than a free win.

Also implemented -- the "Day-1.5" signal set
-------------------------------------------
SPATEM TS 103 301   Signal Phase And Timing. Every signalised intersection
                    broadcasts its current phase, so an approaching vehicle
                    knows what the light will be doing when it arrives.
SREM   TS 103 301   Signal Request Extended Message. How an emergency vehicle
                    asks an intersection for priority.
SSEM   TS 103 301   Signal Status Extended Message. The intersection's answer,
                    carrying a requestStatus the requester can act on.

The point of routing priority through SREM/SSEM rather than a direct call is
that the request can be *refused* and can be *lost on the air* -- which is what
a real deployment has to cope with and a function call never does.

Not implemented
---------------
MAPEM -- intersection topology, which SPaT references by lane id. See
docs/ROADMAP.md.

Frame sizing
------------
`payload_bytes` below are representative ASN.1 UPER *encoded* sizes, not
`len(str(python_dict))`. A signed CAM on the air is around 300 bytes and a
signed DENM around 380, which is what these constants reproduce.

Two things are deliberately modelled because they change the results:

* **Certificate attachment.** TS 103 097 does not put a full certificate on
  every frame -- that would be ruinous at 10 Hz. A station attaches its
  certificate roughly once a second and otherwise sends an 8-byte HashedId8
  digest, trusting the receiver to have cached it. See
  `CertificateAttachmentPolicy`.
* **The privacy/bandwidth trade.** Rotating a pseudonym throws away whatever
  certificate the receivers had cached, so the first frame under a new
  pseudonym must carry the full certificate again. Keying the policy by
  pseudonym makes that fall out automatically, and it is the reason privacy
  is not free here.

Backhaul traffic (the centralized baseline's telemetry stream) is not C-ITS
and does not pay the 1609.2 envelope -- it rides TLS over IP, whose framing is
folded into `BACKHAUL_FRAMING_BYTES`. Note this is the *conservative* choice
for the comparison this project makes: it makes the centralized baseline
cheaper than the old model did, not more expensive. A real deployment would
also batch probe records, reducing per-record framing further.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from enum import IntEnum, StrEnum

_id_counter = itertools.count(1)


def next_message_id() -> str:
    return f"msg-{next(_id_counter)}-{int(time.time() * 1000) % 100000}"


class Bearer(StrEnum):
    """Which radio or link a frame travels over."""

    #: ETSI EN 302 663 ITS-G5, or the equivalent C-V2X PC5 sidelink. Broadcast,
    #: unlicensed/ITS band, no infrastructure required.
    ITS_G5 = "its-g5"
    #: An IP link from a station to the cloud. Metered, and unavailable during
    #: the scripted outages.
    BACKHAUL = "backhaul"


class MessageType(StrEnum):
    #: EN 302 637-2 Cooperative Awareness Message.
    CAM = "cam"
    #: EN 302 637-3 DENM describing a road hazard.
    DENM_HAZARD = "denm-hazard"
    #: EN 302 637-3 DENM, cause 95 -- an emergency vehicle is approaching.
    DENM_EVA = "denm-eva"
    #: TS 103 301 SPATEM -- signal phase and timing, broadcast by every
    #: signalised intersection.
    SPATEM = "spatem"
    #: TS 103 301 SREM -- a priority request from an emergency vehicle.
    SREM = "srem"
    #: TS 103 301 SSEM -- the intersection's answer to a SREM.
    SSEM = "ssem"
    #: EN 302 637-3 DENM, cause 99/1 -- this vehicle is braking hard. The
    #: rear-end collision case: the car behind is warned before its driver
    #: can see why.
    DENM_EEBL = "denm-eebl"
    #: TS 103 324 Collective Perception Message -- what this station's
    #: *sensors* can see, shared so a station with a blocked view learns
    #: about a road user it cannot detect itself.
    CPM = "cpm"
    #: Cooperative intent: where this vehicle is planning to go next.
    MCM = "mcm"
    #: Raw probe data streamed to a central service. Not a C-ITS message.
    TELEMETRY_UPLOAD = "telemetry-upload"


class SignalRequestStatus(StrEnum):
    """SSEM requestStatus values (TS 103 301 / SAE J2735 PrioritizationResponseStatus)."""

    REQUESTED = "requested"
    PROCESSING = "processing"
    GRANTED = "granted"
    REJECTED = "rejected"


class CauseCode(IntEnum):
    """DENM causeCode values from the TS 102 894-2 Common Data Dictionary.

    Only the codes this simulation can actually raise are listed; the CDD
    defines around a hundred.
    """

    ACCIDENT = 2
    ADVERSE_WEATHER_ADHESION = 6
    HAZARDOUS_LOCATION_SURFACE_CONDITION = 9
    ADVERSE_WEATHER_VISIBILITY = 19
    STATIONARY_VEHICLE = 94
    EMERGENCY_VEHICLE_APPROACHING = 95
    DANGEROUS_SITUATION = 99
    #: A person is on the carriageway -- the turning-pedestrian case.
    HUMAN_PRESENCE_ON_THE_ROAD = 12


#: Maps this simulation's hazard vocabulary onto (causeCode, subCauseCode).
#: Where the CDD has no matching subcause the value degrades to 0, which the
#: standard defines as "unavailable" -- that is the correct encoding, not a
#: placeholder.
HAZARD_CAUSE_CODES: dict[str, tuple[CauseCode, int]] = {
    # subCauseCode 0 = unavailable; the CDD's accident subcauses describe the
    # collision type, which an on-board detector cannot classify.
    "accident": (CauseCode.ACCIDENT, 0),
    # stationaryVehicle / vehicleBreakdown
    "stalled_vehicle": (CauseCode.STATIONARY_VEHICLE, 2),
    # dangerousSituation / emergencyElectronicBrakeEngaged
    "hard_braking": (CauseCode.DANGEROUS_SITUATION, 1),
    # The CDD has no standing-water subcause under hazardousLocation-
    # SurfaceCondition, so this correctly encodes as "unavailable".
    "waterlogging": (CauseCode.HAZARDOUS_LOCATION_SURFACE_CONDITION, 0),
    # adverseWeatherCondition-Adhesion / fuelOnTheRoad
    "oil_spill": (CauseCode.ADVERSE_WEATHER_ADHESION, 2),
    # adverseWeatherCondition-Visibility / fog
    "fog_bank": (CauseCode.ADVERSE_WEATHER_VISIBILITY, 1),
    # humanPresenceOnTheRoad / childrenOnRoadway is subcause 1; a crossing
    # adult is subcause 0 (unavailable) in the CDD.
    "pedestrian_crossing": (CauseCode.HUMAN_PRESENCE_ON_THE_ROAD, 0),
}


def cause_for(hazard_type: str) -> tuple[int, int]:
    """(causeCode, subCauseCode) for a hazard label, defaulting to
    dangerousSituation/unavailable for anything unrecognised."""
    cause, sub = HAZARD_CAUSE_CODES.get(hazard_type, (CauseCode.DANGEROUS_SITUATION, 0))
    return int(cause), sub


# --------------------------------------------------------------- wire sizes
#: protocolVersion + messageID + stationID, common to every ITS PDU.
ITS_PDU_HEADER_BYTES = 4
#: IP + TCP + TLS record framing, amortised per probe record.
BACKHAUL_FRAMING_BYTES = 20

#: ECDSA P-256 signature, r || s.
SIGNATURE_BYTES = 64
#: SignedData wrapper: hashId, psid, generationTime, signer info tags.
SIGNED_DATA_OVERHEAD_BYTES = 17
#: An explicit 1609.2 certificate for an ITS station.
CERTIFICATE_BYTES = 117
#: HashedId8 -- the receiver is expected to have the certificate cached.
CERTIFICATE_DIGEST_BYTES = 8
#: TS 103 097 wants a full certificate about once a second; at a 10 Hz CAM
#: rate that is every tenth frame.
CERT_ATTACH_INTERVAL_MESSAGES = 10


@dataclass(frozen=True)
class MessageSpec:
    """What a message type is, and what it costs on the air."""

    designator: str
    standard: str
    label: str
    bearer: Bearer
    #: Representative ASN.1 UPER encoded payload, excluding the ITS PDU header
    #: and the security envelope.
    payload_bytes: int

    @property
    def framing_bytes(self) -> int:
        return ITS_PDU_HEADER_BYTES if self.bearer is Bearer.ITS_G5 else BACKHAUL_FRAMING_BYTES

    @property
    def secured(self) -> bool:
        """ITS-G5 frames carry a 1609.2 envelope; backhaul rides TLS."""
        return self.bearer is Bearer.ITS_G5


MESSAGE_SPECS: dict[MessageType, MessageSpec] = {
    MessageType.CAM: MessageSpec(
        designator="CAM",
        standard="ETSI EN 302 637-2",
        label="Cooperative awareness",
        bearer=Bearer.ITS_G5,
        # basicContainer + highFrequencyContainer, no low-frequency container.
        payload_bytes=117,
    ),
    MessageType.DENM_HAZARD: MessageSpec(
        designator="DENM",
        standard="ETSI EN 302 637-3",
        label="Hazard notification",
        bearer=Bearer.ITS_G5,
        # management + situation + location containers.
        payload_bytes=180,
    ),
    MessageType.DENM_EVA: MessageSpec(
        designator="DENM",
        standard="ETSI EN 302 637-3",
        label="Emergency vehicle approaching",
        bearer=Bearer.ITS_G5,
        # As above; the predicted path and ETA table ride in variable_bytes.
        payload_bytes=180,
    ),
    MessageType.SPATEM: MessageSpec(
        designator="SPATEM",
        standard="ETSI TS 103 301",
        label="Signal phase and timing",
        bearer=Bearer.ITS_G5,
        # IntersectionState with a handful of MovementStates. A real SPaT for
        # a complex junction is larger; this is a simple four-approach one.
        payload_bytes=96,
    ),
    MessageType.SREM: MessageSpec(
        designator="SREM",
        standard="ETSI TS 103 301",
        label="Signal priority request",
        bearer=Bearer.ITS_G5,
        # RequestorDescription + one SignalRequest.
        payload_bytes=84,
    ),
    MessageType.SSEM: MessageSpec(
        designator="SSEM",
        standard="ETSI TS 103 301",
        label="Signal request status",
        bearer=Bearer.ITS_G5,
        # SignalStatus with the request's id and its disposition.
        payload_bytes=64,
    ),
    MessageType.DENM_EEBL: MessageSpec(
        designator="DENM",
        standard="ETSI EN 302 637-3",
        label="Emergency electronic brake light",
        bearer=Bearer.ITS_G5,
        payload_bytes=180,
    ),
    MessageType.CPM: MessageSpec(
        designator="CPM",
        standard="ETSI TS 103 324",
        label="Collective perception",
        bearer=Bearer.ITS_G5,
        # Management + sensor information containers. The perceived objects
        # themselves are variable and ride in `variable_bytes`.
        payload_bytes=121,
    ),
    MessageType.MCM: MessageSpec(
        designator="MCM",
        standard="ETSI TR 103 578",
        label="Maneuver coordination (intent sharing)",
        bearer=Bearer.ITS_G5,
        # Management + manoeuvre containers. The intended path itself is
        # variable and rides in `variable_bytes`, one entry per planned hop,
        # so announcing a longer plan genuinely costs more air time.
        payload_bytes=118,
    ),
    MessageType.TELEMETRY_UPLOAD: MessageSpec(
        designator="probe",
        standard="non-standard backhaul",
        label="Raw probe-data upload",
        bearer=Bearer.BACKHAUL,
        # position, segment, speed, progress, heading, timestamp.
        payload_bytes=72,
    ),
}

#: One waypoint of a predicted emergency path plus its ETA, UPER encoded.
PATH_POINT_BYTES = 12
#: One PerceivedObject in a CPM: id, position, speed, classification and the
#: confidence values that come with each. This is why collective perception
#: is expensive -- the frame grows with everything you can see.
PERCEIVED_OBJECT_BYTES = 35


class CertificateAttachmentPolicy:
    """Decides whether a frame carries a full certificate or just a digest.

    Keyed by the *pseudonym* a station is currently broadcasting under, so a
    pseudonym rotation naturally invalidates the receivers' cached certificate
    and forces a full re-attach on the next frame -- which is precisely the
    bandwidth price of unlinkability.
    """

    def __init__(self, interval: int = CERT_ATTACH_INTERVAL_MESSAGES) -> None:
        self._interval = max(1, interval)
        self._counts: dict[str, int] = {}
        self.certificates_attached = 0
        self.digests_attached = 0

    def attach(self, station_key: str) -> bool:
        seen = self._counts.get(station_key, 0)
        self._counts[station_key] = seen + 1
        full = seen % self._interval == 0
        if full:
            self.certificates_attached += 1
        else:
            self.digests_attached += 1
        return full

    @property
    def bytes_saved(self) -> int:
        """What digest-instead-of-certificate has saved so far."""
        return self.digests_attached * (CERTIFICATE_BYTES - CERTIFICATE_DIGEST_BYTES)

    def snapshot(self) -> dict:
        total = self.certificates_attached + self.digests_attached
        return {
            "frames_secured": total,
            "certificates_attached": self.certificates_attached,
            "digests_attached": self.digests_attached,
            "attach_interval": self._interval,
            "kilobytes_saved": round(self.bytes_saved / 1024, 2),
        }


def backhaul_bytes(msg: Message) -> int:
    """What a frame's content costs uploaded over TLS/IP instead of broadcast
    over ITS-G5: different framing, and no 1609.2 envelope because the
    transport already authenticates the peer."""
    return BACKHAUL_FRAMING_BYTES + msg.spec.payload_bytes + msg.variable_bytes


@dataclass
class Message:
    type: MessageType
    sender_id: str
    payload: dict
    ttl: int = 3
    id: str = field(default_factory=next_message_id)
    created_tick: int = 0
    signature: str = ""
    origin_segment: str | None = None
    # The pseudonym the frame was broadcast under. Receivers see this and
    # never the underlying station identity (see network/pseudonyms.py).
    pseudonym: str = ""
    #: Content whose size genuinely varies with the payload -- an emergency
    #: path, a batch of probe records -- in bytes.
    variable_bytes: int = 0
    #: Set by `CertificateAttachmentPolicy` before the frame goes on the air.
    certificate_attached: bool = False

    @property
    def spec(self) -> MessageSpec:
        return MESSAGE_SPECS[self.type]

    @property
    def bearer(self) -> Bearer:
        return self.spec.bearer

    @property
    def security_bytes(self) -> int:
        """The 1609.2 / TS 103 097 envelope. Unsigned or backhaul frames pay
        nothing here."""
        if not self.signature or not self.spec.secured:
            return 0
        credential = CERTIFICATE_BYTES if self.certificate_attached else CERTIFICATE_DIGEST_BYTES
        return SIGNATURE_BYTES + SIGNED_DATA_OVERHEAD_BYTES + credential

    @property
    def size_bytes(self) -> int:
        spec = self.spec
        return spec.framing_bytes + spec.payload_bytes + self.variable_bytes + self.security_bytes

    def relayed(self) -> Message:
        """A copy with TTL decremented, for gossip relay.

        The relay re-signs with its own credentials, so certificate
        attachment is decided again by whoever forwards it.
        """
        return Message(
            type=self.type,
            sender_id=self.sender_id,
            payload=self.payload,
            ttl=self.ttl - 1,
            id=self.id,
            created_tick=self.created_tick,
            signature=self.signature,
            origin_segment=self.origin_segment,
            pseudonym=self.pseudonym,
            variable_bytes=self.variable_bytes,
            certificate_attached=self.certificate_attached,
        )
