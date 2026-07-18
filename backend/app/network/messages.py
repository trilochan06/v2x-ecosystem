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
        )
