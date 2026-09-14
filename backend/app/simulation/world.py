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

HAZARD_TYPES = ["accident", "stalled_vehicle", "hard_braking", "waterlogging", "oil_spill", "fog_bank"]


def node_id(x: int, y: int) -> str:
    return f"{x}-{y}"


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

    def decay_occupancy(self, factor: float = 0.985) -> None:
        for seg in self.segments.values():
            seg.occupancy = max(0.0, seg.occupancy * factor)
            seg.record()
