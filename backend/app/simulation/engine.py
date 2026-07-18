"""Orchestrates one simulation tick across every layer of the architecture:
vehicle sensing/movement, V2V gossip delivery, RSU edge aggregation +
inference, self-healing cell handover, cloud digests, traffic-light
control, and emergency corridor formation. This is the "ecosystem" the
digital twin dashboard visualizes in real time.
"""
from __future__ import annotations

import itertools
import random
from dataclasses import dataclass, field

from app.ai.congestion_model import CongestionPredictor
from app.emergency.corridor import EmergencyCorridorManager
from app.network.corroboration import INCIDENT_DURATION_TICKS, CorroborationEngine
from app.network.gossip import EtherBus, RecipientHandle
from app.network.messages import Message, MessageType
from app.network.rsu_network import RSUNetwork
from app.network.security import TrustRegistry
from app.simulation.fog import FogNode, build_fog_clusters
from app.simulation.rsu import RSU
from app.simulation.traffic_light import TrafficLight
from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid, node_id

MAX_EVENTS = 150
FOG_CLUSTER_SIZE = 3
FOG_INTERVAL_TICKS = 20


def _new_counter():
    return itertools.count(1)


@dataclass
class SimulationEngine:
    grid_size: int = 6
    num_rsus: int = 6
    num_vehicles: int = 26

    def __post_init__(self):
        self.grid = CityGrid(size=self.grid_size)
        self.tick = 0
        self.bus = EtherBus(self.grid)
        self.trust = TrustRegistry()
        self.rsu_network = RSUNetwork()
        self.predictor = CongestionPredictor()
        self.corridor_mgr = EmergencyCorridorManager(self.grid)
        self.corroboration = CorroborationEngine()
        self.vehicles: dict[str, Vehicle] = {}
        self.rsus: dict[str, RSU] = {}
        self.fog_nodes: dict[str, FogNode] = {}
        self.traffic_lights: dict[str, TrafficLight] = {}
        self.event_log: list[dict] = []
        self.messages_this_tick = 0
        self.reroutes_this_tick = 0
        self._vehicle_counter = _new_counter()
        self._spawn_initial()

    # ---------------------------------------------------------------- setup
    def _spawn_initial(self) -> None:
        rsu_nodes = self._evenly_spaced_nodes(self.num_rsus)
        rsu_coords: dict[str, tuple[float, float]] = {}
        for i, node in enumerate(rsu_nodes):
            rsu_id = f"rsu-{i+1}"
            self.rsus[rsu_id] = RSU(id=rsu_id, node=node, grid=self.grid)
            self.rsu_network.register_rsu(rsu_id, node)
            self.bus.register(rsu_id)
            self.traffic_lights[node] = TrafficLight(id=f"light-{node}", node=node)
            rsu_coords[rsu_id] = tuple(float(c) for c in self.grid.coords(node))

        for fog in build_fog_clusters(list(self.rsus.keys()), rsu_coords, cluster_size=FOG_CLUSTER_SIZE):
            self.fog_nodes[fog.id] = fog

        for _ in range(self.num_vehicles):
            self.spawn_vehicle("car")

        self._log(
            "system_start",
            f"Simulation started with {self.num_rsus} RSUs across {len(self.fog_nodes)} fog clusters "
            f"and {self.num_vehicles} vehicles.",
        )

    def _evenly_spaced_nodes(self, count: int) -> list[str]:
        """Spread `count` nodes across the full 2D grid (roughly a
        cols x rows sub-grid) rather than picking every Nth node from a
        flattened list, which collapses onto a single row/column.
        """
        size = self.grid_size
        cols = max(1, round(count**0.5))
        rows = max(1, -(-count // cols))  # ceil division
        xs = self._spread(size, cols)
        ys = self._spread(size, rows)
        nodes = [node_id(x, y) for y in ys for x in xs]
        return nodes[:count]

    @staticmethod
    def _spread(size: int, n: int) -> list[int]:
        if n == 1:
            return [size // 2]
        return [round(i * (size - 1) / (n - 1)) for i in range(n)]

    def spawn_vehicle(self, kind: str = "car") -> Vehicle:
        node = random.choice(list(self.grid.nodes.keys()))
        vid = f"{kind}-{next(self._vehicle_counter)}"
        speed = 55.0 if kind == "ambulance" else 42.0
        v = Vehicle(id=vid, kind=kind, grid=self.grid, node=node, speed_kmh=speed)
        self.vehicles[vid] = v
        self.trust.register(vid)
        self.bus.register(vid)
        if kind == "ambulance":
            self._log("ambulance_spawned", f"Ambulance {vid} dispatched, route to {v.destination}.")
        elif kind == "malicious":
            self._log("malicious_spawned", f"Malicious node {vid} injected into the network.")
        return v

    def remove_vehicle(self, vehicle_id: str) -> None:
        self.vehicles.pop(vehicle_id, None)

    def toggle_rsu(self, rsu_id: str, alive: bool) -> None:
        if rsu_id not in self.rsus:
            return
        self.rsus[rsu_id].alive = alive
        self.rsu_network.set_alive(rsu_id, alive)
        state = "restored" if alive else "went DOWN"
        self._log("rsu_fault" if not alive else "rsu_recovered", f"{rsu_id} {state}.")

    # ----------------------------------------------------------------- tick
    def step(self) -> None:
        self.tick += 1
        self.messages_this_tick = 0
        self.reroutes_this_tick = 0

        outbound: list[tuple[Vehicle, Message]] = []
        for v in self.vehicles.values():
            messages, rerouted = v.step(self.tick)
            for msg in messages:
                outbound.append((v, msg))
            if rerouted:
                self.reroutes_this_tick += 1
                self._log("v2v_reroute", f"Vehicle {v.id} rerouted using peer-shared congestion data.")

        recipients = self._recipient_handles()
        seen_by_rsu: dict[str, tuple[str, Message]] = {}
        for sender_vehicle, msg in outbound:
            delivered = self.bus.broadcast(msg, sender_vehicle.node, self.tick, recipients)
            self.messages_this_tick += len(delivered)

            if msg.type == MessageType.HAZARD_REPORT:
                for node_id in delivered:
                    if node_id in self.rsus and self.rsus[node_id].alive:
                        # a hazard report may reach several RSUs; corroboration
                        # is judged network-wide so we only need one copy of it
                        seen_by_rsu[msg.id] = (sender_vehicle.id, msg)
            elif msg.type == MessageType.OCCUPANCY_PING:
                for node_id in delivered:
                    peer = self.vehicles.get(node_id)
                    if peer is not None:
                        peer.receive_occupancy_ping(msg.payload["segment_id"], msg.payload["occupancy"], self.tick)

        network_reports = list(seen_by_rsu.values())
        if network_reports:
            self.corroboration.process(network_reports, self.trust, self.grid, self.tick)
            for sender_id, _msg in network_reports:
                v = self.vehicles.get(sender_id)
                if v:
                    v.trust_hint = self.trust.score(sender_id)

        for rsu in self.rsus.values():
            if not rsu.alive:
                continue
            rsu.run_prediction(self.predictor, self.tick)
            digest = rsu.build_digest(self.tick, self.rsu_network)
            if digest and digest.incident_count > 0:
                self._log(
                    "congestion_alert",
                    f"{rsu.id} cloud digest: avg occupancy {digest.avg_occupancy}, {digest.incident_count} incident(s).",
                )

        if self.tick % FOG_INTERVAL_TICKS == 0:
            for fog in self.fog_nodes.values():
                was_alert = fog.alert
                fog.aggregate(self.tick, self.rsus, self.rsu_network)
                if fog.alert and not was_alert:
                    self._log(
                        "fog_alert",
                        f"{fog.id} regional congestion alert across {', '.join(fog.member_rsu_ids)} "
                        "-- coordinating signal timing across the cluster.",
                    )
                elif was_alert and not fog.alert:
                    self._log("fog_recovered", f"{fog.id} regional congestion cleared.")

        for v in self.vehicles.values():
            self.rsu_network.assign_vehicle(self.grid, v.id, v.node, self.tick)

        for light in self.traffic_lights.values():
            light.step(self.tick)

        ambulances = [v for v in self.vehicles.values() if v.kind == "ambulance"]
        if ambulances:
            self.corridor_mgr.step(self.tick, ambulances, list(self.vehicles.values()), self.traffic_lights)

        self._decay_incidents()
        self.grid.decay_occupancy(factor=0.985)

        for entry in self.rsu_network.handover_log[-5:]:
            if entry["tick"] == self.tick:
                self._log("self_heal", f"Vehicle {entry['vehicle_id']} handed over {entry['from']} -> {entry['to']}.")

    def _recipient_handles(self) -> list[RecipientHandle]:
        handles = [RecipientHandle(node_id=r.id, grid_node=r.node, is_alive=r.alive) for r in self.rsus.values()]
        handles += [RecipientHandle(node_id=v.id, grid_node=v.node, is_alive=True) for v in self.vehicles.values()]
        return handles

    def _decay_incidents(self) -> None:
        for seg in self.grid.all_segments():
            if seg.incident:
                seg.incident_ttl -= 1
                if seg.incident_ttl <= 0:
                    seg.incident = False

    def mark_incident(self, segment_id: str) -> None:
        seg = self.grid.segments.get(segment_id)
        if seg:
            seg.incident = True
            seg.incident_ttl = INCIDENT_DURATION_TICKS

    def _log(self, event_type: str, message: str) -> None:
        self.event_log.append({"tick": self.tick, "type": event_type, "message": message})
        if len(self.event_log) > MAX_EVENTS:
            self.event_log.pop(0)

    # -------------------------------------------------------------- output
    def state_snapshot(self) -> dict:
        return {
            "tick": self.tick,
            "grid_size": self.grid_size,
            "messages_this_tick": self.messages_this_tick,
            "reroutes_this_tick": self.reroutes_this_tick,
            "total_reroutes": sum(v.reroute_count for v in self.vehicles.values()),
            "fog_nodes": [f.to_state() for f in self.fog_nodes.values()],
            "segments": [
                {
                    "id": s.id,
                    "a": s.a,
                    "b": s.b,
                    "occupancy": round(s.occupancy, 3),
                    "incident": s.incident,
                }
                for s in self.grid.all_segments()
            ],
            "vehicles": [v.to_state() for v in self.vehicles.values()],
            "rsus": [
                {**rsu.to_state(), "cell_size": sum(1 for c in self.rsu_network.vehicle_cell.values() if c == rsu.id)}
                for rsu in self.rsus.values()
            ],
            "traffic_lights": [t.to_state() for t in self.traffic_lights.values()],
            "trust": self.trust.snapshot(),
            "cloud_digests": [d.__dict__ for d in self.rsu_network.cloud_digests[-20:]],
            "handovers": self.rsu_network.handover_log[-20:],
            "corridor_events": self.corridor_mgr.events[-20:],
            "active_corridors": list(self.corridor_mgr.active_corridors.keys()),
            "events": list(reversed(self.event_log[-40:])),
        }
