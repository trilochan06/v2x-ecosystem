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
from app.ai.federated import FederatedCoordinator
from app.emergency.corridor import EmergencyCorridorManager
from app.network.corroboration import INCIDENT_DURATION_TICKS, CorroborationEngine
from app.network.gossip import EtherBus, RecipientHandle
from app.network.messages import Message, MessageType
from app.network.rsu_network import RSUNetwork
from app.network.security import TrustRegistry
from app.simulation.fog import FogNode, build_fog_clusters
from app.simulation.rsu import RSU
from app.simulation.traffic_light import TrafficLight
from app.simulation.twin import TransportDigitalTwin
from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid, node_id

MAX_EVENTS = 150
FOG_CLUSTER_SIZE = 3
FOG_INTERVAL_TICKS = 20
# Physical hazards arise on their own, not only when an operator injects one.
# Without this there is nothing real for honest vehicles to report, every
# corroborated incident is by construction a false positive, and the twin's
# divergence detector has no unmodelled event to find.
HAZARD_SPAWN_PROBABILITY = 0.05
HAZARD_TTL_RANGE = (35, 70)


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
        self.federated = FederatedCoordinator()
        self.twin = TransportDigitalTwin()
        self.corridor_mgr = EmergencyCorridorManager(self.grid)
        self.corroboration = CorroborationEngine()
        self.vehicles: dict[str, Vehicle] = {}
        self.rsus: dict[str, RSU] = {}
        self.fog_nodes: dict[str, FogNode] = {}
        self.traffic_lights: dict[str, TrafficLight] = {}
        self.event_log: list[dict] = []
        self.messages_this_tick = 0
        self.reroutes_this_tick = 0
        # Detection is scored per hazard episode, not per tick -- see
        # _score_detection.
        self._detection = {"true_positives": 0, "false_positives": 0, "false_negatives": 0}
        self._hazard_open: dict[str, bool] = {}
        self._belief_open: dict[str, bool] = {}
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
            rsu.collect_training_data(
                self.federated, self.tick, source_trust=self._source_trust(rsu)
            )
            digest = rsu.build_digest(self.tick, self.rsu_network)
            if digest and digest.incident_count > 0:
                self._log(
                    "congestion_alert",
                    f"{rsu.id} cloud digest: avg occupancy {digest.avg_occupancy}, {digest.incident_count} incident(s).",
                )

        if self.federated.should_run(self.tick):
            summary = self.federated.run_round(self.tick)
            if summary is not None:
                saved_kb = summary.raw_bytes_avoided / 1024
                note = (
                    f"FL round {summary.round}: {len(summary.participants)} RSUs, "
                    f"loss {summary.global_loss:.4f}, {saved_kb:.1f} KB of raw telemetry "
                    "never transmitted."
                )
                if summary.excluded:
                    note += f" Excluded below trust floor: {', '.join(summary.excluded)}."
                self._log("federated_round", note)

        if self.twin.should_sync(self.tick):
            was_alert = self.twin.alert
            self.twin.sync(self.grid, self.tick)
            if self.twin.alert and not was_alert:
                self._log(
                    "twin_divergence",
                    f"Digital twin diverged from physical state "
                    f"(mean gap {self.twin.divergence:.3f}, worst segment "
                    f"{self.twin.max_segment_gap:.3f}) -- replica no longer authoritative.",
                )
            elif was_alert and not self.twin.alert:
                self._log("twin_resynced", "Digital twin divergence back within bounds.")

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

        self._spawn_random_hazard()
        self._score_detection()
        self._decay_incidents()
        self._recompute_occupancy()

        for entry in self.rsu_network.handover_log[-5:]:
            if entry["tick"] == self.tick:
                self._log("self_heal", f"Vehicle {entry['vehicle_id']} handed over {entry['from']} -> {entry['to']}.")

    def _score_detection(self) -> None:
        """Score each hazard and each confirmation once, as an episode.

        An instantaneous count of segments in each state is dominated by how
        many hazards happen to be live at the moment it is read. Counting
        episodes -- did this hazard ever get confirmed before it expired, was
        this confirmation ever backed by a real hazard -- is the quantity the
        precision and recall of a detector actually refer to.
        """
        for seg in self.grid.all_segments():
            real, believed = seg.incident, seg.reported_incident

            if real and seg.id not in self._hazard_open:
                self._hazard_open[seg.id] = False  # not yet confirmed
            if real and believed:
                self._hazard_open[seg.id] = True
            if not real and seg.id in self._hazard_open:
                # The hazard has expired: was it ever confirmed?
                if self._hazard_open.pop(seg.id):
                    self._detection["true_positives"] += 1
                else:
                    self._detection["false_negatives"] += 1

            if believed and seg.id not in self._belief_open:
                self._belief_open[seg.id] = real
            elif believed and real:
                self._belief_open[seg.id] = True
            if not believed and seg.id in self._belief_open:
                # A confirmation that never coincided with a real hazard was
                # a false alarm, whatever the network thought at the time.
                if not self._belief_open.pop(seg.id):
                    self._detection["false_positives"] += 1

    def detection_quality(self) -> dict:
        """Compare what the network believes against what is physically there.

        This is only meaningful because the two are stored separately and no
        network component can read the physical flag -- see Segment.
        """
        tp = self._detection["true_positives"]
        fp = self._detection["false_positives"]
        fn = self._detection["false_negatives"]
        precision = tp / (tp + fp) if (tp + fp) else 1.0
        recall = tp / (tp + fn) if (tp + fn) else 1.0
        f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        return {
            "true_positives": tp,
            "false_positives": fp,
            "false_negatives": fn,
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "f1": round(f1, 3),
        }

    def _source_trust(self, rsu: RSU) -> float:
        """How much this unit's own data sources are believed.

        A unit's picture of its roads is assembled from the vehicles currently
        in its cell, so the trust of that picture is the mean trust of those
        vehicles. The registry already maintains these scores for hazard
        validation; the federated layer just reads them.
        """
        members = [
            vid for vid, cell in self.rsu_network.vehicle_cell.items() if cell == rsu.id
        ]
        if not members:
            return 1.0
        return sum(self.trust.score(vid) for vid in members) / len(members)

    def _recipient_handles(self) -> list[RecipientHandle]:
        handles = [RecipientHandle(node_id=r.id, grid_node=r.node, is_alive=r.alive) for r in self.rsus.values()]
        handles += [RecipientHandle(node_id=v.id, grid_node=v.node, is_alive=True) for v in self.vehicles.values()]
        return handles

    def _recompute_occupancy(self) -> None:
        """Occupancy is a density over who is on each road right now."""
        counts: dict[str, int] = {}
        for v in self.vehicles.values():
            sid = v.current_segment_id
            if sid:
                counts[sid] = counts.get(sid, 0) + 1
        self.grid.set_occupancy(counts)

    def _spawn_random_hazard(self) -> None:
        if random.random() >= HAZARD_SPAWN_PROBABILITY:
            return
        clear = [s for s in self.grid.all_segments() if not s.incident]
        if not clear:
            return
        seg = random.choice(clear)
        seg.incident = True
        seg.incident_ttl = random.randint(*HAZARD_TTL_RANGE)
        self._log("hazard_appeared", f"Hazard appeared on segment {seg.id}.")

    def _decay_incidents(self) -> None:
        for seg in self.grid.all_segments():
            if seg.incident:
                seg.incident_ttl -= 1
                if seg.incident_ttl <= 0:
                    seg.incident = False
            if seg.reported_incident:
                seg.reported_ttl -= 1
                if seg.reported_ttl <= 0:
                    seg.reported_incident = False

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
                    "reported_incident": s.reported_incident,
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
            "federated": self.federated.to_state(),
            "detection": self.detection_quality(),
            "digital_twin": self.twin.to_state(self.tick),
            "cloud_digests": [d.__dict__ for d in self.rsu_network.cloud_digests[-20:]],
            "handovers": self.rsu_network.handover_log[-20:],
            "corridor_events": self.corridor_mgr.events[-20:],
            "active_corridors": list(self.corridor_mgr.active_corridors.keys()),
            "events": list(reversed(self.event_log[-40:])),
        }
