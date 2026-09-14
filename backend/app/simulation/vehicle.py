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
import zlib
from dataclasses import dataclass, field
from typing import Literal

from app.network.messages import (
    PATH_POINT_BYTES,
    PERCEIVED_OBJECT_BYTES,
    Message,
    MessageType,
    cause_for,
)
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

# How long a vehicle keeps believing a pedestrian report it can no longer
# confirm itself.
PEDESTRIAN_MEMORY_TICKS = 8
# A hard-braking manoeuvre lasts this long and is broadcast throughout.
BRAKING_TICKS = 3
# What a hard brake does to speed, and what a pedestrian warning does.
BRAKING_SPEED_FACTOR = 0.2
PEDESTRIAN_CAUTION_FACTOR = 0.45
# Below this share of the segment remaining, a signal is close enough that
# holding a speed to catch the green is worth advising.
GLOSA_APPROACH_PROGRESS = 0.35

# --- M6b: intent coordination ------------------------------------------
# How often a vehicle announces where it is planning to go.
INTENT_BROADCAST_INTERVAL_TICKS = 5
# How far ahead it commits to. Announcing the whole route would be both a
# privacy giveaway and stale by the time it mattered.
INTENT_HORIZON_HOPS = 4
# A claim older than this is no longer evidence of anyone's plan.
INTENT_STALE_TICKS = 12
# How much one peer's announced claim inflates a road's cost. At 0.6 a road
# four peers have claimed looks ~2.4x longer than an empty one, which is
# enough to tip the marginal vehicle onto the next-best detour without
# making the obvious route unusable for everyone.
INTENT_CLAIM_WEIGHT = 0.6
# A road a peer warned about is not banned outright any more -- it is priced
# as very expensive, so it stays available when every alternative is worse.
AVOID_SEGMENT_PENALTY = 12.0
# Per-vehicle route jitter, and the reason this whole mechanism works.
#
# Every road here is the same length, so the shortest-path search is really
# minimising hop count and ties are everywhere. Break those ties the same way
# in every vehicle -- which both a breadth-first search and a plain Dijkstra
# do -- and two cars in the same place heading the same way compute the
# byte-identical detour. That is the herding effect at its source: not bad
# pricing, just determinism. A small per-vehicle perturbation makes tied
# routes resolve differently for different vehicles while leaving a genuinely
# shorter route still shorter.
ROUTE_JITTER = 0.25

# How long a wreck sits in the carriageway before it is cleared and the
# vehicles rejoin traffic.
CRASH_IMMOBILE_TICKS = 22
# A wrecked vehicle re-announces itself on this duty cycle. Every tick would
# be both unrealistic and a denial of service on its own neighbours.
CRASH_REPORT_INTERVAL_TICKS = 3
# What a wreck does to the lane it is sitting in.
CRASH_LANE_BLOCKAGE = 0.25


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

    # --- Porsche prototype 1: emergency electronic brake light -----------
    #: Ticks left of a hard-braking manoeuvre. While non-zero the vehicle is
    #: decelerating sharply and broadcasting a DENM about it.
    braking_ticks: int = 0

    # --- Porsche prototype 2: collective perception ----------------------
    #: Pedestrians this vehicle can physically see, set by the engine from
    #: line of sight. segment_id -> tick.
    seen_pedestrians: dict[str, int] = field(default_factory=dict)
    #: Pedestrians it only knows about because a peer shared them in a CPM.
    #: This is the set that a car turning blind into a crossing acts on.
    told_pedestrians: dict[str, int] = field(default_factory=dict)

    # --- Porsche prototype 3: GLOSA --------------------------------------
    #: Signal phase heard over SPaT. node -> (phase, tick).
    known_signals: dict[str, tuple[str, int]] = field(default_factory=dict)
    #: The speed advice derived from it, in km/h, or None when no signal is
    #: within earshot.
    glosa_advice: float | None = None

    # --- collision -------------------------------------------------------
    #: Ticks left before the wreck is cleared. While non-zero this vehicle is
    #: immobile, blocking its lane, and announcing the accident.
    crashed_ticks: int = 0
    #: Tick the collision happened, so the UI can say how long ago.
    crashed_at_tick: int = -1

    # --- M6b: intent coordination ----------------------------------------
    #: What peers have announced they intend to drive. segment_id -> (claims,
    #: tick). Written only by `receive_intent`, so like every other peer
    #: belief it exists because a frame was actually delivered.
    peer_intent: dict[str, tuple[int, int]] = field(default_factory=dict)
    #: Whether this vehicle announces its plan and prices detours by what
    #: peers have claimed. Set by the engine from the architecture config.
    intent_coordination: bool = False

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

        # A wreck does not drive. It sits in the lane, blocks it, and keeps
        # announcing itself until it is cleared -- which is what gives the
        # traffic behind time to be warned and rerouted.
        if self.crashed_ticks > 0:
            self.crashed_ticks -= 1
            seg.occupancy = min(1.0, seg.occupancy + CRASH_LANE_BLOCKAGE)
            self.glosa_advice = None
            # A wreck is stationary, not deaf and blind. It already announces
            # the accident, so refusing to share the pedestrian standing in
            # front of it would be an odd place to draw the line -- and it
            # silently starved collective perception on exactly the road where
            # it matters most.
            for message in (self._report_crash(seg, tick), self._maybe_share_perception(tick)):
                if message is not None:
                    outbound.append(message)
            return outbound, False, None

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

        # A pedestrian on the carriageway ahead. Whether this vehicle can see
        # them or was only told by a peer, it slows -- that equivalence is the
        # point of collective perception.
        if self.knows_pedestrian_on(seg.id, tick):
            effective_speed *= PEDESTRIAN_CAUTION_FACTOR

        # Hard braking dominates everything else while it lasts.
        if self.braking_ticks > 0:
            self.braking_ticks -= 1
            effective_speed *= BRAKING_SPEED_FACTOR

        # GLOSA: hold a speed that arrives on green rather than braking at a
        # red and accelerating away from it.
        self.glosa_advice = self._glosa_advice(nxt, tick, effective_speed)
        if self.glosa_advice is not None:
            effective_speed = min(effective_speed, self.glosa_advice)

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
            eebl = self._maybe_report_braking(seg, tick)
            if eebl is not None:
                outbound.append(eebl)

            cpm = self._maybe_share_perception(tick)
            if cpm is not None:
                outbound.append(cpm)

            ping = self._maybe_share_occupancy(seg, tick)
            if ping is not None:
                outbound.append(ping)

            if self.intent_coordination:
                intent = self._maybe_share_intent(tick)
                if intent is not None:
                    outbound.append(intent)

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
        # A DENM identifies what it saw with a CauseCode/SubCauseCode from the
        # TS 102 894-2 dictionary, not a free-text label -- that is what makes
        # it interpretable by equipment that has never heard of this project.
        cause_code, sub_cause_code = cause_for(hazard_type)
        payload = {
            "segment_id": seg.id,
            "hazard_type": hazard_type,
            "cause_code": cause_code,
            "sub_cause_code": sub_cause_code,
            "confidence": confidence,
        }
        return Message(
            type=MessageType.DENM_HAZARD,
            sender_id=self.id,
            pseudonym=self.pseudonym,
            payload=payload,
            ttl=self.comm_range_hops,
            created_tick=tick,
            signature=sign(payload, self.signing_key),
            origin_segment=seg.id,
        )

    # --------------------------------- Porsche 1: emergency brake light
    def brake_hard(self) -> None:
        """Begin a hard-braking manoeuvre. The engine calls this when a
        pedestrian steps out in front of this vehicle."""
        self.braking_ticks = BRAKING_TICKS

    def _maybe_report_braking(self, seg, tick: int) -> Message | None:
        """DENM cause 99/1, emergencyElectronicBrakeEngaged.

        The rear-end case from the article: this car brakes because a child
        stepped out, and the car behind is told immediately rather than when
        its driver notices the brake lights."""
        if self.braking_ticks <= 0 or self.kind == "malicious":
            return None
        cause_code, sub_cause_code = cause_for("hard_braking")
        payload = {
            "segment_id": seg.id,
            "hazard_type": "hard_braking",
            "cause_code": cause_code,
            "sub_cause_code": sub_cause_code,
            "confidence": 1.0,
        }
        return Message(
            type=MessageType.DENM_EEBL,
            sender_id=self.id,
            pseudonym=self.pseudonym,
            payload=payload,
            ttl=2,  # only the traffic immediately behind needs this
            created_tick=tick,
            signature=sign(payload, self.signing_key),
            origin_segment=seg.id,
        )

    # --------------------------------------------------------- collision
    def crash(self, tick: int) -> None:
        """Involve this vehicle in a collision. The engine calls this on both
        parties at once."""
        self.crashed_ticks = CRASH_IMMOBILE_TICKS
        self.crashed_at_tick = tick
        self.braking_ticks = 0
        self.yield_instruction = None

    @property
    def crashed(self) -> bool:
        return self.crashed_ticks > 0

    def _report_crash(self, seg, tick: int) -> Message | None:
        """The wreck announcing itself: DENM causeCode 2, accident.

        Confidence is 1.0 because the sender *is* the accident -- this is the
        one hazard report that needs no corroborating witness to be certain,
        even though the network still corroborates it like any other.
        """
        if tick % CRASH_REPORT_INTERVAL_TICKS != 0:
            return None
        cause_code, sub_cause_code = cause_for("accident")
        payload = {
            "segment_id": seg.id,
            "hazard_type": "accident",
            "cause_code": cause_code,
            "sub_cause_code": sub_cause_code,
            "confidence": 1.0,
        }
        return Message(
            type=MessageType.DENM_HAZARD,
            sender_id=self.id,
            pseudonym=self.pseudonym,
            payload=payload,
            ttl=self.comm_range_hops,
            created_tick=tick,
            signature=sign(payload, self.signing_key),
            origin_segment=seg.id,
        )

    # ------------------------------------ Porsche 2: collective perception
    def _maybe_share_perception(self, tick: int) -> Message | None:
        """TS 103 324 CPM: publish what this vehicle's sensors can see.

        Only objects it can *actually* see are shared. Re-broadcasting what
        someone else told you would turn one sighting into a rumour with no
        source, which is precisely what the standard's confidence fields
        exist to prevent."""
        fresh = [
            seg_id
            for seg_id, heard in self.seen_pedestrians.items()
            if tick - heard <= 1
        ]
        if not fresh or self.kind == "malicious":
            return None
        cause_code, sub_cause_code = cause_for("pedestrian_crossing")
        payload = {
            "objects": len(fresh),
            "segment_id": fresh[0],
            "cause_code": cause_code,
            "sub_cause_code": sub_cause_code,
        }
        return Message(
            type=MessageType.CPM,
            sender_id=self.id,
            pseudonym=self.pseudonym,
            payload=payload,
            ttl=2,
            created_tick=tick,
            signature=sign(payload, self.signing_key),
            # The frame grows with everything you can see: collective
            # perception is a bandwidth trade, not a free win.
            variable_bytes=len(fresh) * PERCEIVED_OBJECT_BYTES,
        )

    # ------------------------------------------------- Porsche 3: GLOSA
    def _glosa_advice(self, nxt: str, tick: int, current_speed: float) -> float | None:
        """Green Light Optimal Speed Advisory, from the SPaT already heard.

        No new message type: the intersection is broadcasting its phase
        anyway, and this is what a vehicle can do with it. Arriving at a
        steady 30 km/h beats arriving at 50 and stopping."""
        known = self.known_signals.get(nxt)
        if known is None:
            return None
        phase, heard = known
        if tick - heard > PEDESTRIAN_MEMORY_TICKS:
            return None  # stale; the light may well have changed
        if phase != "red":
            return None  # it is green, so just carry on
        if 1.0 - self.progress > GLOSA_APPROACH_PROGRESS:
            return None  # too far away for the advice to mean anything

        # Ease off rather than race up to a red and brake.
        return max(12.0, current_speed * 0.55)

    # ------------------------------------------------- M2 peer occupancy
    def _maybe_share_occupancy(self, seg, tick: int) -> Message | None:
        if tick % OCCUPANCY_PING_INTERVAL_TICKS != 0:
            return None
        # An attacker's CAM is where false *traffic state* enters the network.
        # Its hazard DENMs are caught by corroboration; this is the quieter
        # channel, and it is the one that reaches the training data.
        reported = seg.occupancy
        if self.kind == "malicious":
            reported = 1.0 - seg.occupancy
        payload = {"segment_id": seg.id, "occupancy": round(reported, 3)}
        return Message(
            type=MessageType.CAM,
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

    def receive_perceived_object(self, segment_id: str, tick: int) -> None:
        """A peer's CPM told us about a road user on `segment_id`.

        Kept apart from `seen_pedestrians` on purpose: the difference between
        what a vehicle can see and what it has been told is exactly what
        collective perception buys, and the site draws that distinction."""
        self.told_pedestrians[segment_id] = tick

    def receive_signal_phase(self, node: str, phase: str, tick: int) -> None:
        """SPaT from an intersection ahead."""
        self.known_signals[node] = (phase, tick)

    def knows_pedestrian_on(self, segment_id: str | None, tick: int) -> bool:
        if segment_id is None:
            return False
        for source in (self.seen_pedestrians, self.told_pedestrians):
            heard = source.get(segment_id)
            if heard is not None and tick - heard <= PEDESTRIAN_MEMORY_TICKS:
                return True
        return False

    def pedestrian_known_only_from_peers(self, segment_id: str | None, tick: int) -> bool:
        """True when the only reason this vehicle knows is that it was told.

        The turning case: the corner blocks the view, so without a peer's CPM
        the driver would arrive at the crossing with no warning at all."""
        if segment_id is None:
            return False
        seen = self.seen_pedestrians.get(segment_id)
        if seen is not None and tick - seen <= PEDESTRIAN_MEMORY_TICKS:
            return False
        told = self.told_pedestrians.get(segment_id)
        return told is not None and tick - told <= PEDESTRIAN_MEMORY_TICKS

    def _recent_warning(self, segment_id: str, tick: int) -> bool:
        heard = self.hazard_warnings.get(segment_id)
        return heard is not None and tick - heard <= PEER_INFO_STALE_TICKS

    # ----------------------------------------------- M6 local rerouting
    # --------------------------------------------- M6b intent coordination
    def intended_segments(self) -> list[str]:
        """The next few roads this vehicle is planning to drive."""
        out: list[str] = []
        horizon = self.route[: INTENT_HORIZON_HOPS + 1]
        for i in range(len(horizon) - 1):
            out.append(self.grid.segment_between(horizon[i], horizon[i + 1]).id)
        return out

    def _maybe_share_intent(self, tick: int) -> Message | None:
        """MCM: announce the plan, so peers can avoid all picking it.

        This is the message that makes coordination possible without any
        central assignment: nobody is told where to go, they are only told
        where everyone else is already going.
        """
        if tick % INTENT_BROADCAST_INTERVAL_TICKS != 0 or self.kind == "malicious":
            return None
        planned = self.intended_segments()
        if not planned:
            return None
        payload = {"segments": ",".join(planned), "hops": len(planned)}
        return Message(
            type=MessageType.MCM,
            sender_id=self.id,
            pseudonym=self.pseudonym,
            payload=payload,
            ttl=2,
            created_tick=tick,
            signature=sign(payload, self.signing_key),
            # Announcing a longer plan costs more air time, so the horizon is
            # a real trade rather than free foresight.
            variable_bytes=len(planned) * PATH_POINT_BYTES,
        )

    def receive_intent(self, segment_ids: list[str], tick: int) -> None:
        for seg_id in segment_ids:
            claims, heard = self.peer_intent.get(seg_id, (0, tick))
            fresh = claims if tick - heard <= INTENT_STALE_TICKS else 0
            self.peer_intent[seg_id] = (fresh + 1, tick)

    def _route_jitter(self, segment_id: str) -> float:
        """A stable per-vehicle, per-road perturbation in [0, ROUTE_JITTER).

        Deterministic from the ids -- crc32 rather than `hash()`, whose seed
        varies between processes -- so a run is still reproducible from its
        seed, while different vehicles disagree about which of two equal-length
        roads to prefer.
        """
        digest = zlib.crc32(f"{self.id}|{segment_id}".encode())
        return ROUTE_JITTER * (digest % 1000) / 1000.0

    def claimed_by_peers(self, segment_id: str, tick: int) -> int:
        """How many peers have recently said they are taking this road."""
        claims, heard = self.peer_intent.get(segment_id, (0, -999))
        return claims if tick - heard <= INTENT_STALE_TICKS else 0

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

        new_route = self._detour(frozenset(avoid), tick)
        if new_route and new_route != self.route:
            self.route = new_route
            self._reroute_cooldown_until = tick + REROUTE_COOLDOWN_TICKS
            self.reroute_count += 1
            return True
        return False

    def _detour(self, avoid: frozenset[str], tick: int) -> list[str]:
        """Pick a way around the roads this vehicle has been warned about.

        Without coordination this is a breadth-first search, so two vehicles
        in the same place heading the same way get byte-identical detours --
        and a whole platoon arrives on the same alternative at once. That is
        the herding effect, and it is why greedy rerouting can be *worse*
        than not rerouting at all.

        With coordination the same search is weighted by what peers have
        announced. The first vehicles to replan take the obvious detour; once
        enough of them have claimed it, it prices itself out and the next
        vehicle picks the second-best road instead. No central assignment and
        no negotiation -- just each vehicle reacting to what it was told.
        """
        if not self.intent_coordination:
            return self.grid.shortest_path_avoiding(self.node, self.destination, avoid)

        def cost(seg) -> float:
            penalty = AVOID_SEGMENT_PENALTY if seg.id in avoid else 1.0
            claims = self.claimed_by_peers(seg.id, tick)
            return (
                seg.length_m
                * penalty
                * (1.0 + INTENT_CLAIM_WEIGHT * claims)
                * (1.0 + self._route_jitter(seg.id))
            )

        route = self.grid.least_cost_path(self.node, self.destination, cost)
        # Unreachable under this cost (it should not be, since nothing is
        # banned outright) -- fall back rather than strand the vehicle.
        return route or self.grid.shortest_path_avoiding(self.node, self.destination, avoid)

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
            # The three Porsche prototypes, as this vehicle experiences them.
            "braking": self.braking_ticks > 0,
            "glosa_advice": round(self.glosa_advice, 1) if self.glosa_advice is not None else None,
            "crashed": self.crashed,
            "crashed_ticks": self.crashed_ticks,
        }
