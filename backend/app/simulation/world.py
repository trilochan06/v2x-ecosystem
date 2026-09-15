"""L1 - Physical / Sensing layer: the road network itself.

A synthetic city: an N x N grid of intersections joined by bidirectional
road segments. Each segment carries live occupancy (what loop detectors and
vehicle telemetry would measure) plus two *separate* hazard states:

  hazard_active      the physical truth -- there really is a hazard here
  confirmed_incident what the V2X network currently believes

Keeping those apart is what makes detection quality measurable. If the
system's belief were the same field as the ground truth, hazard
precision/recall would be tautologically perfect, and the deck's
"Precision/Recall for hazard detection" metric would mean nothing.
"""
from __future__ import annotations

import heapq
import math
from dataclasses import dataclass, field

# How many vehicles on one 250 m segment count as a jam.
#
# Deliberately small. A real 250 m lane holds far more, but this simulation runs
# tens of vehicles over sixty segments, not hundreds -- at a realistic jam
# density nothing would ever be congested and there would be no congestion story
# to measure. Four is the number at which a road here is saturated, and every
# occupancy figure in the project is relative to it.
JAM_VEHICLES_PER_SEGMENT = 4

#: How quickly occupancy follows what is on the road. Low enough that a road
#: does not flicker as a car crosses a junction, high enough to keep up.
OCCUPANCY_SMOOTHING = 0.25

HAZARD_TYPES = ["accident", "stalled_vehicle", "hard_braking", "waterlogging", "oil_spill", "fog_bank"]


def node_id(x: int, y: int) -> str:
    return f"{x}-{y}"


# --------------------------------------------------------------- land use
# What a place is for.
#
# Traffic used to be a random walk: on arrival every vehicle drew a uniformly
# random node and set off again. That produces motion but not traffic -- no
# rush toward anywhere, so congestion could only ever come from the hazard
# injector, and the congestion forecaster was predicting noise.
#
# Giving the grid land use costs one lookup table and buys three things: trips
# that have a reason, jams that form where people are actually going, and an
# incident report that can say which district it happened in.
LAND_USES = ("centre", "civic", "industrial", "residential")

#: How much more likely a place is to be someone's destination.
ATTRACTION = {"centre": 3.2, "industrial": 1.8, "civic": 1.5, "residential": 1.0}

LAND_USE_LABEL = {
    "centre": "City Centre",
    "civic": "Civic quarter",
    "industrial": "Industrial estate",
    "residential": "Residential",
}

#: Why someone is driving -- derived from where they are going, and used by the
#: explanation panel to say something more useful than "destination 4-2".
TRIP_PURPOSE = {
    "centre": "commuting into the centre",
    "civic": "heading for the hospital quarter",
    "industrial": "on a delivery run to the estate",
    "residential": "driving home",
}


def civic_nodes(size: int) -> list[str]:
    """Where the civic quarter sits, for a grid of this size.

    Fixed rather than random so that both engines, every seed and every replay
    put the hospital in the same place -- an audience that has seen the map
    once should not have to relearn it.
    """
    return [node_id(0, size - 1), node_id(size - 1, 0)]


def land_use_of(node: str, size: int) -> str:
    x, y = (int(v) for v in node.split("-"))
    mid = (size - 1) / 2
    if max(abs(x - mid), abs(y - mid)) <= max(0.5, (size - 1) * 0.2):
        return "centre"
    if node in civic_nodes(size):
        return "civic"
    estate = math.ceil(size / 3)
    if x >= size - estate and y >= size - estate:
        return "industrial"
    return "residential"


# ------------------------------------------------------------ place names
# Street names, because `5-3_5-4` is not something anyone can hold in their
# head -- and an incident log that reads like a matrix index is the single
# biggest reason a viewer cannot follow what the system is doing.
#
# North-south roads are avenues and carry a name; east-west roads are numbered
# crosses. Beyond the name list the scheme degrades to a number rather than
# repeating, so any grid size stays unambiguous.
AVENUE_NAMES = [
    "Harbour",
    "Mill",
    "Cathedral",
    "University",
    "Park",
    "Station",
    "Foundry",
    "Orchard",
]


def _avenue(x: int) -> str:
    return AVENUE_NAMES[x] if x < len(AVENUE_NAMES) else f"Ave {x + 1}"


def avenue_name(x: int) -> str:
    return f"{AVENUE_NAMES[x]} Avenue" if x < len(AVENUE_NAMES) else f"Avenue {x + 1}"


def cross_name(y: int) -> str:
    n = y + 1
    # 11th, 12th and 13th are the exceptions the modulo rule gets wrong.
    suffix = "th" if 11 <= n % 100 <= 13 else {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix} Cross"


def junction_name(node: str) -> str:
    """Cathedral Ave x 3rd Cross -- how a junction is referred to out loud."""
    x, y = (int(v) for v in node.split("-"))
    return f"{avenue_name(x).replace(' Avenue', ' Ave')} × {cross_name(y)}"


def road_name(segment_id: str) -> str:
    """3rd Cross, Cathedral-University block -- one segment, in words."""
    a, b = segment_id.split("_")
    ax, ay = (int(v) for v in a.split("-"))
    bx, by = (int(v) for v in b.split("-"))
    if ay == by:
        return f"{cross_name(ay)}, {_avenue(ax)}–{_avenue(bx)} block"
    lo, hi = min(ay, by), max(ay, by)
    return f"{avenue_name(ax)}, {cross_name(lo)}–{cross_name(hi)}"


@dataclass
class Pedestrian:
    """A vulnerable road user stepping onto a crossing.

    The point of modelling these is line of sight. A pedestrian crossing at an
    intersection is plainly visible to a car coming straight down that road,
    and invisible to a car about to turn into it from the perpendicular
    street -- the corner of the building is in the way. That asymmetry is the
    whole reason collective perception exists, and it is what the turning
    case in the Porsche prototypes is about.
    """

    id: str
    #: The intersection being crossed at.
    node: str
    #: The segment whose carriageway the pedestrian is standing on.
    segment_id: str
    ticks_remaining: int
    started_tick: int = 0

    @property
    def active(self) -> bool:
        return self.ticks_remaining > 0

    def step(self) -> None:
        self.ticks_remaining = max(0, self.ticks_remaining - 1)

    def to_state(self, seen_by: list[str], known_by: list[str]) -> dict:
        return {
            "id": self.id,
            "node": self.node,
            "segment_id": self.segment_id,
            "ticks_remaining": self.ticks_remaining,
            # Who can physically see them, versus who only knows because a
            # peer told them. The gap between these two lists is the value
            # collective perception adds, made visible.
            "seen_by": seen_by,
            "known_by": known_by,
        }


@dataclass
class Segment:
    id: str
    a: str
    b: str
    length_m: float
    speed_limit_kmh: float
    occupancy: float = 0.0

    # --- physical ground truth -------------------------------------------
    hazard_active: bool = False
    hazard_type: str = ""
    hazard_ttl: int = 0
    hazard_started_tick: int = -1

    # --- what the network has corroborated --------------------------------
    confirmed_incident: bool = False
    confirmed_tick: int = -1
    confirmed_ttl: int = 0

    history: list[float] = field(default_factory=list)

    def record(self) -> None:
        self.history.append(self.occupancy)
        if len(self.history) > 240:
            self.history.pop(0)

    def raise_hazard(self, hazard_type: str, ttl: int, tick: int) -> None:
        self.hazard_active = True
        self.hazard_type = hazard_type
        self.hazard_ttl = ttl
        self.hazard_started_tick = tick

    def clear_hazard(self) -> None:
        self.hazard_active = False
        self.hazard_type = ""
        self.hazard_ttl = 0
        self.hazard_started_tick = -1

    def confirm_incident(self, tick: int, ttl: int) -> bool:
        """Mark the network's belief. Returns True the first time this
        belief is raised (used for detection-latency accounting)."""
        first = not self.confirmed_incident
        self.confirmed_incident = True
        self.confirmed_ttl = ttl
        if first:
            self.confirmed_tick = tick
        return first

    def tick_down(self) -> None:
        if self.hazard_active:
            self.hazard_ttl -= 1
            if self.hazard_ttl <= 0:
                self.clear_hazard()
        if self.confirmed_incident:
            self.confirmed_ttl -= 1
            if self.confirmed_ttl <= 0:
                self.confirmed_incident = False
                self.confirmed_tick = -1


class CityGrid:
    """N x N grid graph. Nodes are intersections, edges are road segments."""

    def __init__(self, size: int = 6, block_m: float = 250.0):
        self.size = size
        self.block_m = block_m
        self.nodes: dict[str, tuple[int, int]] = {}
        self.segments: dict[str, Segment] = {}
        self.adjacency: dict[str, list[str]] = {}
        self._build()

    def _build(self) -> None:
        for x in range(self.size):
            for y in range(self.size):
                nid = node_id(x, y)
                self.nodes[nid] = (x, y)
                self.adjacency[nid] = []

        for x in range(self.size):
            for y in range(self.size):
                a = node_id(x, y)
                if x + 1 < self.size:
                    self._add_segment(a, node_id(x + 1, y))
                if y + 1 < self.size:
                    self._add_segment(a, node_id(x, y + 1))

    def _add_segment(self, a: str, b: str) -> None:
        sid = f"{a}_{b}"
        self.segments[sid] = Segment(id=sid, a=a, b=b, length_m=self.block_m, speed_limit_kmh=45.0)
        self.adjacency[a].append(b)
        self.adjacency[b].append(a)

    def segment_between(self, a: str, b: str) -> Segment:
        sid = f"{a}_{b}"
        if sid in self.segments:
            return self.segments[sid]
        return self.segments[f"{b}_{a}"]

    def land_use(self, node: str) -> str:
        return land_use_of(node, self.size)

    def attraction(self, node: str) -> float:
        """How strongly this junction pulls trips towards it."""
        return ATTRACTION[self.land_use(node)]

    def neighbors(self, node: str) -> list[str]:
        return self.adjacency[node]

    def coords(self, node: str) -> tuple[int, int]:
        return self.nodes[node]

    def euclidean(self, a: str, b: str) -> float:
        ax, ay = self.coords(a)
        bx, by = self.coords(b)
        return math.hypot(ax - bx, ay - by) * self.block_m

    def shortest_path(self, start: str, goal: str) -> list[str]:
        return self.shortest_path_avoiding(start, goal, avoid_segment_ids=frozenset())

    def shortest_path_avoiding(self, start: str, goal: str, avoid_segment_ids: frozenset[str]) -> list[str]:
        """Shortest path routing around a set of segments a vehicle has
        learned (via V2X) are congested or blocked. Falls back to the plain
        shortest path when no detour exists."""
        if start == goal:
            return [start]
        visited = {start}
        queue = [[start]]
        while queue:
            path = queue.pop(0)
            node = path[-1]
            for nxt in self.adjacency[node]:
                if nxt in visited:
                    continue
                if avoid_segment_ids and self.segment_between(node, nxt).id in avoid_segment_ids:
                    continue
                new_path = path + [nxt]
                if nxt == goal:
                    return new_path
                visited.add(nxt)
                queue.append(new_path)
        if avoid_segment_ids:
            return self.shortest_path_avoiding(start, goal, avoid_segment_ids=frozenset())
        return [start]

    def least_cost_path(self, start: str, goal: str, segment_cost) -> list[str]:
        """Cheapest path under an arbitrary per-segment cost (Dijkstra).

        `shortest_path_avoiding` is a breadth-first search, so every vehicle
        with a similar position and destination gets the identical detour --
        which is exactly how greedy rerouting stampedes a whole platoon onto
        one alternative. A weighted search lets a vehicle price a road by how
        many peers have already announced they are taking it.

        Returns [] when the goal is unreachable under this cost, so the caller
        can fall back rather than silently accept a bad route.
        """
        if start == goal:
            return [start]

        best: dict[str, float] = {start: 0.0}
        came_from: dict[str, str] = {}
        # heapq orders on the tuple; the node id breaks ties deterministically
        # so a run stays reproducible from its seed.
        frontier: list[tuple[float, str]] = [(0.0, start)]
        settled: set[str] = set()

        while frontier:
            cost, node = heapq.heappop(frontier)
            if node in settled:
                continue
            settled.add(node)
            if node == goal:
                break
            for nxt in self.adjacency[node]:
                if nxt in settled:
                    continue
                step = segment_cost(self.segment_between(node, nxt))
                if step is None or step == math.inf:
                    continue
                candidate = cost + step
                if candidate < best.get(nxt, math.inf):
                    best[nxt] = candidate
                    came_from[nxt] = node
                    heapq.heappush(frontier, (candidate, nxt))

        if goal not in came_from:
            return []

        path = [goal]
        while path[-1] != start:
            path.append(came_from[path[-1]])
        path.reverse()
        return path

    def all_segments(self) -> list[Segment]:
        return list(self.segments.values())

    def adjacent_segments(self, segment: Segment) -> list[Segment]:
        """Every other segment sharing an endpoint -- the spillover
        neighbourhood used as the congestion model's `neighbor_avg`."""
        seen = {segment.id}
        result = []
        for node in (segment.a, segment.b):
            for neighbor in self.adjacency[node]:
                seg = self.segment_between(node, neighbor)
                if seg.id not in seen:
                    seen.add(seg.id)
                    result.append(seg)
        return result

    def set_occupancy(self, counts: dict[str, int], extra: dict[str, float]) -> None:
        """Set each road's occupancy from what is actually on it this tick.

        This used to accumulate: every vehicle added a fixed amount each tick
        and the whole thing decayed slowly. Over the eighteen ticks a car takes
        to cross a segment that drives one road to about 0.7, and two cars peg
        it at 1.0 -- so occupancy was effectively a binary "has anything been
        here lately", nearly every occupied road read as jammed, and the
        roadside units' estimate of road state was 100% everywhere. Three
        things depended on that number and all three were reading a saturated
        signal.

        It is a density now: how many vehicles are on the road against how many
        constitute a jam, smoothed so it does not flicker between ticks. One car
        on an empty road reads as light traffic, which is what it is.

        `extra` carries what blocks a lane without being traffic -- a wreck
        sitting in it.
        """
        for seg in self.segments.values():
            instant = min(
                1.0,
                counts.get(seg.id, 0) / JAM_VEHICLES_PER_SEGMENT + extra.get(seg.id, 0.0),
            )
            seg.occupancy = (
                seg.occupancy * (1 - OCCUPANCY_SMOOTHING) + instant * OCCUPANCY_SMOOTHING
            )
            if seg.occupancy < 1e-4:
                seg.occupancy = 0.0
            seg.record()
