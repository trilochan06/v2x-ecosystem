"""Vehicle agent: a rolling AI compute node, not just a GPS transmitter.

Every tick each vehicle senses its local road segment, decides whether to
gossip a hazard report to nearby vehicles/RSUs, and advances along its
route. A "malicious" vehicle kind is included so the trust/security layer
has something real to defend against (fabricated hazard reports that no
other vehicle corroborates).
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Literal

from app.network.messages import Message, MessageType
from app.network.security import issue_certificate, sign
from app.simulation.world import CityGrid

VehicleKind = Literal["car", "ambulance", "malicious"]

HAZARD_TYPES = ["fog", "accident", "pothole", "waterlogging", "oil_spill"]

OCCUPANCY_PING_INTERVAL_TICKS = 4
OCCUPANCY_PING_TTL_HOPS = 2
PEER_INFO_STALE_TICKS = 15
CONGESTION_REROUTE_THRESHOLD = 0.8
REROUTE_COOLDOWN_TICKS = 25
REROUTE_LOOKAHEAD_HOPS = 3


@dataclass
class Vehicle:
    id: str
    kind: VehicleKind
    grid: CityGrid
    node: str
    destination: str = ""
    route: list[str] = field(default_factory=list)
    progress: float = 0.0  # 0..1 along current segment
    speed_kmh: float = 42.0
    cert_key: str = field(default_factory=issue_certificate)
    comm_range_hops: int = 3
    yield_instruction: dict | None = None
    trust_hint: float = 1.0
    # Peer-shared congestion knowledge (V2V), NOT read directly off the
    # shared world state -- a vehicle only "knows" about a segment it
    # hasn't personally driven if another vehicle told it, via a message,
    # within the last few ticks. This is what makes the rerouting below a
    # genuine decentralized decision rather than omniscient shortcut.
    known_occupancy: dict[str, tuple[float, int]] = field(default_factory=dict)
    reroute_count: int = 0
    _reroute_cooldown_until: int = 0

    def __post_init__(self) -> None:
        if not self.destination:
            self._pick_new_destination()

    def _pick_new_destination(self) -> None:
        candidates = [n for n in self.grid.nodes if n != self.node]
        self.destination = random.choice(candidates)
        self.route = self.grid.shortest_path(self.node, self.destination)
        self.progress = 0.0

    @property
    def next_node(self) -> str | None:
        if len(self.route) >= 2:
            return self.route[1]
        return None

    @property
    def current_segment_id(self):
        nxt = self.next_node
        if nxt is None:
            return None
        return self.grid.segment_between(self.node, nxt).id

    def position_xy(self) -> tuple[float, float]:
        ax, ay = self.grid.coords(self.node)
        nxt = self.next_node
        if nxt is None:
            return float(ax), float(ay)
        bx, by = self.grid.coords(nxt)
        return (ax + (bx - ax) * self.progress, ay + (by - ay) * self.progress)

    def step(self, tick: int, dt_s: float = 1.0) -> tuple[list[Message], bool]:
        """Advance movement + sensing. Returns (outbound messages, did_reroute)."""
        nxt = self.next_node
        outbound: list[Message] = []
        rerouted = False

        if nxt is not None:
            seg = self.grid.segment_between(self.node, nxt)
            bump = 0.05 if self.kind != "ambulance" else 0.02
            seg.occupancy = min(1.0, seg.occupancy + bump)

            effective_speed = self.speed_kmh
            if self.yield_instruction:
                effective_speed *= 0.35  # vehicles slow/pull over for the corridor
            if seg.incident:
                effective_speed *= 0.4

            step_m = effective_speed * 1000 / 3600 * dt_s
            self.progress += step_m / seg.length_m
            if self.progress >= 1.0:
                self.node = nxt
                self.progress = 0.0
                self.route.pop(0)
                if len(self.route) <= 1:
                    self._pick_new_destination()

            hazard_msg = self._maybe_sense(seg, tick)
            if hazard_msg is not None:
                outbound.append(hazard_msg)

            ping_msg = self._maybe_share_occupancy(seg, tick)
            if ping_msg is not None:
                outbound.append(ping_msg)

            rerouted = self._maybe_reroute(tick)

        return outbound, rerouted

    def receive_occupancy_ping(self, segment_id: str, occupancy: float, tick: int) -> None:
        """Record a neighbor's self-reported occupancy for a segment this
        vehicle hasn't necessarily driven itself -- this is the only way a
        vehicle learns about a segment ahead of it.
        """
        self.known_occupancy[segment_id] = (occupancy, tick)

    def _maybe_share_occupancy(self, seg, tick: int) -> Message | None:
        if tick % OCCUPANCY_PING_INTERVAL_TICKS != 0:
            return None
        payload = {"segment_id": seg.id, "occupancy": round(seg.occupancy, 3)}
        return Message(
            type=MessageType.OCCUPANCY_PING,
            sender_id=self.id,
            payload=payload,
            ttl=OCCUPANCY_PING_TTL_HOPS,
            created_tick=tick,
        )

    def _maybe_reroute(self, tick: int) -> bool:
        if self.kind == "ambulance":
            return False  # priority vehicles keep the shortest path; they get right-of-way instead
        if tick < self._reroute_cooldown_until:
            return False
        if len(self.route) < 3:
            return False

        upcoming_nodes = self.route[1 : REROUTE_LOOKAHEAD_HOPS + 2]
        avoid: set[str] = set()
        for i in range(len(upcoming_nodes) - 1):
            seg = self.grid.segment_between(upcoming_nodes[i], upcoming_nodes[i + 1])
            info = self.known_occupancy.get(seg.id)
            if info is None:
                continue
            occupancy, heard_tick = info
            if tick - heard_tick > PEER_INFO_STALE_TICKS:
                continue
            if occupancy >= CONGESTION_REROUTE_THRESHOLD:
                avoid.add(seg.id)

        if not avoid:
            return False

        new_route = self.grid.shortest_path_avoiding(self.node, self.destination, frozenset(avoid))
        if new_route and new_route != self.route:
            self.route = new_route
            self._reroute_cooldown_until = tick + REROUTE_COOLDOWN_TICKS
            self.reroute_count += 1
            return True
        return False

    def _maybe_sense(self, seg, tick: int) -> Message | None:
        if self.kind == "malicious":
            # fabricates hazard reports on segments that are actually clear
            if not seg.incident and random.random() < 0.35:
                return self._build_hazard_message(seg, random.choice(HAZARD_TYPES), confidence=0.9, tick=tick)
            return None

        if seg.incident and random.random() < 0.6:
            hazard = "accident" if seg.incident else random.choice(HAZARD_TYPES)
            return self._build_hazard_message(seg, hazard, confidence=0.8, tick=tick)

        if random.random() < 0.006:
            return self._build_hazard_message(seg, random.choice(HAZARD_TYPES), confidence=0.5, tick=tick)

        return None

    def _build_hazard_message(self, seg, hazard_type: str, confidence: float, tick: int) -> Message:
        payload = {
            "segment_id": seg.id,
            "hazard_type": hazard_type,
            "confidence": confidence,
            "reporter_kind": self.kind,
        }
        signature = sign(payload, self.cert_key)
        return Message(
            type=MessageType.HAZARD_REPORT,
            sender_id=self.id,
            payload=payload,
            ttl=self.comm_range_hops,
            created_tick=tick,
            signature=signature,
            origin_segment=seg.id,
        )

    def to_state(self) -> dict:
        x, y = self.position_xy()
        return {
            "id": self.id,
            "kind": self.kind,
            "x": x,
            "y": y,
            "node": self.node,
            "next_node": self.next_node,
            "destination": self.destination,
            "segment_id": self.current_segment_id,
            "yielding": bool(self.yield_instruction),
            "trust_hint": self.trust_hint,
            "reroute_count": self.reroute_count,
        }
