"""Wire message formats exchanged over the decentralized V2X network.

These are intentionally small, serializable dataclasses -- in the real
architecture they would travel over DSRC/C-V2X radio or a mesh fallback;
here they travel through the in-process `EtherBus` (see gossip.py) which
enforces the same range/TTL/dedup constraints a real radio link would.
"""
from __future__ import annotations

import itertools
import time
from dataclasses import dataclass, field
from enum import Enum

_id_counter = itertools.count(1)


def next_message_id() -> str:
    return f"msg-{next(_id_counter)}-{int(time.time() * 1000) % 100000}"


class MessageType(str, Enum):
    HAZARD_REPORT = "hazard_report"
    OCCUPANCY_PING = "occupancy_ping"
    CONGESTION_DIGEST = "congestion_digest"
    EMERGENCY_BROADCAST = "emergency_broadcast"
    YIELD_INSTRUCTION = "yield_instruction"
    RSU_HEALTH = "rsu_health"
    TELEMETRY_UPLOAD = "telemetry_upload"
    FL_MODEL_UPDATE = "fl_model_update"


# Approximate on-air frame sizes, used for the message-overhead metric.
# A signed 1609.2 frame carries a ~96 byte certificate/signature header on
# top of its payload, which is why chatty designs get expensive fast.
SECURITY_HEADER_BYTES = 96
BASE_HEADER_BYTES = 24


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
    # never the underlying vehicle identity (see network/pseudonyms.py).
    pseudonym: str = ""

    @property
    def size_bytes(self) -> int:
        """Rough frame size: headers + a few bytes per payload field."""
        payload_bytes = sum(len(str(k)) + len(str(v)) for k, v in self.payload.items())
        signed = SECURITY_HEADER_BYTES if self.signature else 0
        return BASE_HEADER_BYTES + payload_bytes + signed

    def relayed(self) -> "Message":
        """Return a copy with TTL decremented, for gossip relay."""
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
        )
