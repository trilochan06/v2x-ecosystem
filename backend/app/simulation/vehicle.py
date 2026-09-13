"""M1 + M3 - Vehicle data acquisition and on-board event detection.

Each vehicle is an intelligent node, not a GPS beacon. Every tick it:

  * senses the road under it (M1) and decides whether what it sees is
    reportable (M3);
  * broadcasts under its current *pseudonym* (M11), never its identity;
  * shares its measured occupancy with nearby peers (M2);
  * reroutes itself around congestion its peers warned it about (M6),
    using only information delivered to it over the air.

That last constraint matters. This is a single process, so a vehicle
object could trivially read the occupancy of every road in the city
straight out of the shared world -- and the "decentralized" claim would be
a lie. Instead `known_occupancy` is written only by
`receive_occupancy_ping()`, which the engine calls only when the radio
layer actually delivered a peer's frame. The one exception is the segment
the vehicle is physically on: feeling the road under your own wheels is
not remote knowledge.
"""
from __future__ import annotations

import random
from dataclasses import dataclass, field
from typing import Literal

from app.network.messages import Message, MessageType
from app.network.security import sign
from app.simulation.world import HAZARD_TYPES, CityGrid

VehicleKind = Literal["car", "ambulance", "malicious"]

OCCUPANCY_PING_INTERVAL_TICKS = 4
OCCUPANCY_PING_TTL_HOPS = 2
PEER_INFO_STALE_TICKS = 15
CONGESTION_REROUTE_THRESHOLD = 0.8
REROUTE_COOLDOWN_TICKS = 25
REROUTE_LOOKAHEAD_HOPS = 3

# How reliably an honest vehicle notices a hazard it is driving through.
HAZARD_SENSE_PROBABILITY = 0.6
# A hazard on the road *ahead* is visible too (line of sight), just less
# reliably. Without this, two independent witnesses to the same hazard
# almost never coincide and nothing ever gets corroborated.
LOOKAHEAD_SENSE_PROBABILITY = 0.3
# Sensor false-positive rate: even honest vehicles occasionally mis-report.
SENSOR_NOISE_PROBABILITY = 0.004
# How aggressively a malicious node fabricates hazards on clear roads.
FABRICATION_PROBABILITY = 0.35


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
    comm_range_hops: int = 3

    # M11 -- the identity actually put on the air, rotated periodically
    pseudonym: str = ""
    signing_key: str = ""

    yield_instruction: dict | None = None
    trust_hint: float = 1.0

    # Peer-shared knowledge (V2V only -- see module docstring)
    known_occupancy: dict[str, tuple[float, int]] = field(default_factory=dict)
    hazard_warnings: dict[str, int] = field(default_factory=dict)  # segment_id -> tick heard

    reroute_count: int = 0
    trip_started_tick: int = 0
    _reroute_cooldown_until: int = 0

    def __post_init__(self) -> None:
        if not self.destination:
            self._pick_new_destination()

    # ------------------------------------------------------------- routing
    def _pick_new_destination(self, tick: int = 0) -> None:
        candidates = [n for n in self.grid.nodes if n != self.node]
        self.destination = random.choice(candidates)
        self.route = self.grid.shortest_path(self.node, self.destination)
        self.progress = 0.0
        self.trip_started_tick = tick

    @property
    def next_node(self) -> str | None:
        return self.route[1] if len(self.route) >= 2 else None

    @property
    def current_segment_id(self) -> str | None:
        nxt = self.next_node
        return None if nxt is None else self.grid.segment_between(self.node, nxt).id

    def position_xy(self) -> tuple[float, float]:
        ax, ay = self.grid.coords(self.node)
        nxt = self.next_node
        if nxt is None:
            return float(ax), float(ay)
        bx, by = self.grid.coords(nxt)
        return (ax + (bx - ax) * self.progress, ay + (by - ay) * self.progress)

    # ---------------------------------------------------------------- tick
    def step(self, tick: int, allow_v2v: bool, allow_rerouting: bool, dt_s: float = 1.0):
        """Advance one tick.

        Returns `(outbound_messages, rerouted, trip_ticks_or_None)`.
        """
        nxt = self.next_node
        outbound: list[Message] = []
        rerouted = False
        completed_trip: int | None = None

        if nxt is None:
            return outbound, rerouted, completed_trip

        seg = self.grid.segment_between(self.node, nxt)
        seg.occupancy = min(1.0, seg.occupancy + (0.02 if self.kind == "ambulance" else 0.05))

        # Greenshields-style speed/density relation: the busier the segment,
        # the slower everyone on it moves. Without this, sitting in a jam is
        # free and any detour is pure loss, which would make congestion-aware
        # rerouting look harmful no matter how well it worked.
        effective_speed = self.speed_kmh * max(0.25, 1.0 - 0.75 * seg.occupancy)
        if self.yield_instruction:
            effective_speed *= 0.35  # pull over for the emergency corridor
        if seg.hazard_active:
            effective_speed *= 0.4  # physically slowed by the obstruction
        if self._recent_warning(seg.id, tick):
            effective_speed *= 0.85  # forewarned, so approaching cautiously

        self.progress += (effective_speed * 1000 / 3600 * dt_s) / seg.length_m
        if self.progress >= 1.0:
            self.node = nxt
            self.progress = 0.0
            self.route.pop(0)
            if len(self.route) <= 1:
                completed_trip = tick - self.trip_started_tick
                self._pick_new_destination(tick)

        hazard_msg = self._maybe_report_hazard(seg, self._lookahead_segment(), tick)
        if hazard_msg is not None:
            outbound.append(hazard_msg)

        if allow_v2v:
            ping = self._maybe_share_occupancy(seg, tick)
            if ping is not None:
                outbound.append(ping)
            if allow_rerouting:
                rerouted = self._maybe_reroute(tick)

        return outbound, rerouted, completed_trip

    # --------------------------------------------------------- M3 sensing
    def _lookahead_segment(self):
        """The segment after the one being driven -- visible ahead."""
        if len(self.route) < 3:
            return None
        return self.grid.segment_between(self.route[1], self.route[2])

    def _maybe_report_hazard(self, seg, ahead, tick: int) -> Message | None:
        if self.kind == "malicious":
            # False-data injection: claims hazards on roads that are clear.
            if not seg.hazard_active and random.random() < FABRICATION_PROBABILITY:
                return self._hazard_message(seg, random.choice(HAZARD_TYPES), 0.9, tick)
            return None

        if seg.hazard_active and random.random() < HAZARD_SENSE_PROBABILITY:
            return self._hazard_message(seg, seg.hazard_type or "accident", 0.85, tick)

        if ahead is not None and ahead.hazard_active and random.random() < LOOKAHEAD_SENSE_PROBABILITY:
            return self._hazard_message(ahead, ahead.hazard_type or "accident", 0.7, tick)

        if random.random() < SENSOR_NOISE_PROBABILITY:
            return self._hazard_message(seg, random.choice(HAZARD_TYPES), 0.5, tick)

        return None

    def _hazard_message(self, seg, hazard_type: str, confidence: float, tick: int) -> Message:
        payload = {
            "segment_id": seg.id,
            "hazard_type": hazard_type,
            "confidence": confidence,
        }
        return Message(
            type=MessageType.HAZARD_REPORT,
            sender_id=self.id,
            pseudonym=self.pseudonym,
            payload=payload,
            ttl=self.comm_range_hops,
            created_tick=tick,
            signature=sign(payload, self.signing_key),
            origin_segment=seg.id,
        )

    # ------------------------------------------------- M2 peer occupancy
    def _maybe_share_occupancy(self, seg, tick: int) -> Message | None:
        if tick % OCCUPANCY_PING_INTERVAL_TICKS != 0:
            return None
        payload = {"segment_id": seg.id, "occupancy": round(seg.occupancy, 3)}
        return Message(
            type=MessageType.OCCUPANCY_PING,
            sender_id=self.id,
            pseudonym=self.pseudonym,
            payload=payload,
            ttl=OCCUPANCY_PING_TTL_HOPS,
            created_tick=tick,
            signature=sign(payload, self.signing_key),
        )

    def receive_occupancy_ping(self, segment_id: str, occupancy: float, tick: int) -> None:
        self.known_occupancy[segment_id] = (occupancy, tick)

    def receive_hazard_warning(self, segment_id: str, tick: int) -> None:
        self.hazard_warnings[segment_id] = tick

    def _recent_warning(self, segment_id: str, tick: int) -> bool:
        heard = self.hazard_warnings.get(segment_id)
        return heard is not None and tick - heard <= PEER_INFO_STALE_TICKS

    # ----------------------------------------------- M6 local rerouting
    def _maybe_reroute(self, tick: int) -> bool:
        if self.kind == "ambulance":
            return False  # priority vehicles hold their path; traffic yields instead
        if tick < self._reroute_cooldown_until or len(self.route) < 3:
            return False

        upcoming = self.route[1 : REROUTE_LOOKAHEAD_HOPS + 2]
        avoid: set[str] = set()
        for i in range(len(upcoming) - 1):
            seg = self.grid.segment_between(upcoming[i], upcoming[i + 1])
            if self._recent_warning(seg.id, tick):
                avoid.add(seg.id)
                continue
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

    # -------------------------------------------------------------- views
    def to_state(self) -> dict:
        x, y = self.position_xy()
        return {
            "id": self.id,
            "pseudonym": self.pseudonym,
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
