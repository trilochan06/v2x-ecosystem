"""Synthetic city road network: an N x N grid of intersections connected by
bidirectional road segments. Each segment tracks live occupancy (0..1) which
stands in for real sensor/GPS-derived congestion in a production system.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


def node_id(x: int, y: int) -> str:
    return f"{x}-{y}"


# Vehicles on one 250 m segment that constitute a jam. Occupancy is the
# fraction of this, not a running total of everyone who ever drove past.
JAM_VEHICLES_PER_SEGMENT = 4
# How quickly occupancy follows what is on the road. Low enough that a
# segment does not flicker as a car crosses a junction, high enough to keep up.
OCCUPANCY_SMOOTHING = 0.25
# A hazard blocks part of the carriageway without itself being traffic.
INCIDENT_BLOCKAGE = 0.25


@dataclass
class Segment:
    id: str
    a: str
    b: str
    length_m: float
    speed_limit_kmh: float
    occupancy: float = 0.0
    # Physical truth: a hazard is actually present on this road. Only the
    # simulator writes this. No RSU, no vehicle and no model may read it --
    # if they could, detection precision would be a comparison between a
    # quantity and itself.
    incident: bool = False
    incident_ttl: int = 0
    # Network belief: the corroboration layer became convinced there is a
    # hazard here. This is what the infrastructure actually knows, and it can
    # be wrong in both directions -- a real hazard nobody reported, or a
    # fabricated one that two colluding reporters got confirmed.
    reported_incident: bool = False
    reported_ttl: int = 0
    history: list[float] = field(default_factory=list)

    def record(self) -> None:
        self.history.append(self.occupancy)
        if len(self.history) > 120:
            self.history.pop(0)


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
                    b = node_id(x + 1, y)
                    self._add_segment(a, b)
                if y + 1 < self.size:
                    b = node_id(x, y + 1)
                    self._add_segment(a, b)

    def _add_segment(self, a: str, b: str) -> None:
        sid = f"{a}_{b}"
        seg = Segment(id=sid, a=a, b=b, length_m=self.block_m, speed_limit_kmh=45.0)
        self.segments[sid] = seg
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
        """Breadth-first search (uniform edge cost grid, so BFS = shortest path)."""
        return self.shortest_path_avoiding(start, goal, avoid_segment_ids=frozenset())

    def shortest_path_avoiding(self, start: str, goal: str, avoid_segment_ids: frozenset[str]) -> list[str]:
        """Shortest path that routes around a set of segments a vehicle has
        learned (via V2V gossip) are congested or blocked -- falls back to
        the normal shortest path if no detour exists.
        """
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

    def all_segments(self) -> list[Segment]:
        return list(self.segments.values())

    def adjacent_segments(self, segment: Segment) -> list[Segment]:
        """Every other segment sharing an endpoint with `segment` -- the
        real spillover neighborhood an RSU's own sensors can see, used as
        the congestion model's `neighbor_avg` feature.
        """
        seen = {segment.id}
        result = []
        for node in (segment.a, segment.b):
            for neighbor in self.adjacency[node]:
                seg = self.segment_between(node, neighbor)
                if seg.id not in seen:
                    seen.add(seg.id)
                    result.append(seg)
        return result

    def set_occupancy(self, counts: dict[str, int]) -> None:
        """Recompute occupancy as a density from who is actually on each road.

        The previous model accumulated a fixed bump per vehicle-tick and
        decayed slowly, which is not a density at all: a single car crossing
        a segment repeatedly drove it to saturation, so most of the network
        read as jammed, the congestion model trained on lags pinned near 1.0,
        and the rerouting threshold was permanently tripped. Occupancy is now
        vehicles present over the number that constitutes a jam, smoothed
        between ticks so a car crossing a junction does not make the map
        flicker.
        """
        for seg in self.segments.values():
            present = counts.get(seg.id, 0)
            blockage = INCIDENT_BLOCKAGE if seg.incident else 0.0
            instant = min(1.0, present / JAM_VEHICLES_PER_SEGMENT + blockage)
            seg.occupancy = seg.occupancy * (1 - OCCUPANCY_SMOOTHING) + instant * OCCUPANCY_SMOOTHING
            if seg.occupancy < 1e-4:
                seg.occupancy = 0.0
            seg.record()
