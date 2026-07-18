"""Synthetic city road network: an N x N grid of intersections connected by
bidirectional road segments. Each segment tracks live occupancy (0..1) which
stands in for real sensor/GPS-derived congestion in a production system.
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field


def node_id(x: int, y: int) -> str:
    return f"{x}-{y}"


@dataclass
class Segment:
    id: str
    a: str
    b: str
    length_m: float
    speed_limit_kmh: float
    occupancy: float = 0.0
    incident: bool = False
    incident_ttl: int = 0
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
                new_path = path + [nxt]
                if nxt == goal:
                    return new_path
                visited.add(nxt)
                queue.append(new_path)
        return [start]

    def all_segments(self) -> list[Segment]:
        return list(self.segments.values())

    def decay_occupancy(self, factor: float = 0.9) -> None:
        for seg in self.segments.values():
            seg.occupancy = max(0.0, seg.occupancy * factor)
            seg.record()
