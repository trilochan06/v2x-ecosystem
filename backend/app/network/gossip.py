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

import random
from dataclasses import dataclass

from app.network.messages import Message
from app.simulation.world import CityGrid

DEDUP_TTL_TICKS = 40
# Probability one hop of the link succeeds under no contention.
BASE_LINK_RELIABILITY = 0.97
# How hard a fully loaded channel hurts delivery.
CONTENTION_PENALTY = 0.45


@dataclass
class RecipientHandle:
    node_id: str
    grid_node: str
    is_alive: bool = True


class EtherBus:
    def __init__(self, grid: CityGrid, seed: int | None = None):
        self.grid = grid
        self._seen: dict[str, dict[str, int]] = {}
        self.last_delivery_hops: dict[str, int] = {}
        self._rng = random.Random(seed)

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
        channel_load: float = 0.0,
    ) -> tuple[list[str], int]:
        """Deliver `msg` to alive recipients within msg.ttl hops of the origin.

        Returns `(delivered_node_ids, intended_count)`. The two differ
        because the channel is lossy: delivery probability falls with hop
        distance (path loss) and with `channel_load`, the local density of
        simultaneous transmitters. That second term is the deck's
        "communication reliability in dense environments" problem -- the
        more vehicles are talking, the more frames collide -- and it is what
        makes packet delivery ratio a real measurement rather than 1.0 by
        construction.
        """
        self._prune(msg.sender_id, tick)
        reach = self._hop_radius(origin_grid_node, max(msg.ttl, 0))
        delivered: list[str] = []
        intended = 0
        for r in recipients:
            if not r.is_alive:
                continue
            hops = reach.get(r.grid_node)
            if hops is None:
                continue
            self._prune(r.node_id, tick)
            if self._has_seen(r.node_id, msg.id):
                continue

            intended += 1
            if self._rng.random() > self._delivery_probability(hops, channel_load):
                continue  # frame lost on the air

            self._mark_seen(r.node_id, msg.id, tick)
            delivered.append(r.node_id)
            self.last_delivery_hops[msg.id] = hops
        return delivered, intended

    def _delivery_probability(self, hops: int, channel_load: float) -> float:
        per_hop = BASE_LINK_RELIABILITY ** max(hops, 1)
        contention = max(0.0, 1.0 - CONTENTION_PENALTY * min(channel_load, 1.0))
        return max(0.05, per_hop * contention)
