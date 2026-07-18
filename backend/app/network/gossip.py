"""V2V epidemic (gossip) relay + RSU/mesh delivery.

Real DSRC/C-V2X radios have a physical range (~300-1000m) and messages hop
vehicle-to-vehicle to travel further, bounded by a TTL to prevent storms and
deduplicated so a vehicle never re-processes/re-broadcasts the same message.
We approximate physical range with graph-hop distance on the road network:
a message published at intersection X reaches every intersection within
`ttl` hops, and any node (vehicle or RSU) currently located at one of those
intersections receives it -- exactly once, thanks to the dedup cache. This
is what lets hazard information keep propagating through a neighborhood
even when an RSU is down or the internet is unreachable ("mesh fallback").
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.network.messages import Message
from app.simulation.world import CityGrid

DEDUP_TTL_TICKS = 40


@dataclass
class RecipientHandle:
    node_id: str
    grid_node: str
    is_alive: bool = True


class EtherBus:
    def __init__(self, grid: CityGrid):
        self.grid = grid
        self._seen: dict[str, dict[str, int]] = {}
        self.last_delivery_hops: dict[str, int] = {}

    def register(self, node_id: str) -> None:
        self._seen.setdefault(node_id, {})

    def _prune(self, node_id: str, tick: int) -> None:
        cache = self._seen.setdefault(node_id, {})
        expired = [mid for mid, exp in cache.items() if exp <= tick]
        for mid in expired:
            del cache[mid]

    def _has_seen(self, node_id: str, msg_id: str) -> bool:
        return msg_id in self._seen.get(node_id, {})

    def _mark_seen(self, node_id: str, msg_id: str, tick: int) -> None:
        self._seen.setdefault(node_id, {})[msg_id] = tick + DEDUP_TTL_TICKS

    def _hop_radius(self, origin: str, max_hops: int) -> dict[str, int]:
        """BFS from origin over the road graph, capped at max_hops."""
        distances = {origin: 0}
        frontier = [origin]
        while frontier and max(distances.values(), default=0) < max_hops:
            nxt = []
            for node in frontier:
                d = distances[node]
                if d >= max_hops:
                    continue
                for neighbor in self.grid.neighbors(node):
                    if neighbor not in distances:
                        distances[neighbor] = d + 1
                        nxt.append(neighbor)
            frontier = nxt
        return distances

    def broadcast(
        self,
        msg: Message,
        origin_grid_node: str,
        tick: int,
        recipients: list[RecipientHandle],
    ) -> list[str]:
        """Deliver `msg` to every alive recipient within msg.ttl hops of the
        origin that has not already seen it. Returns the list of node_ids
        that newly received (and thus will relay/act on) the message.
        """
        self._prune(msg.sender_id, tick)
        reach = self._hop_radius(origin_grid_node, max(msg.ttl, 0))
        delivered: list[str] = []
        for r in recipients:
            if not r.is_alive:
                continue
            if r.grid_node not in reach:
                continue
            self._prune(r.node_id, tick)
            if self._has_seen(r.node_id, msg.id):
                continue
            self._mark_seen(r.node_id, msg.id, tick)
            delivered.append(r.node_id)
            self.last_delivery_hops[msg.id] = reach[r.grid_node]
        return delivered
