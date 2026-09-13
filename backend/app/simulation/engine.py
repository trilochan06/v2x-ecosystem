"""The ecosystem: one tick across all six layers.

L1 physical sensing -> L2 vehicular comms -> L3 intelligent edge ->
L4 distributed intelligence (FL) -> L5 digital twin & cloud ->
L6 applications (alerts, dashboards).

Every architectural capability is switchable via `ArchitectureConfig`, so
the same engine runs the deck's Exp 1 (centralized baseline), Exp 2 (V2X
without edge intelligence) and Exp 3 (full proposed architecture) over
identical traffic -- which is what makes the comparison meaningful.
"""
from __future__ import annotations

import itertools
import random
from dataclasses import dataclass, field

from app.ai.congestion_model import CongestionPredictor
from app.config import DEFAULT_CONFIG, ArchitectureConfig
from app.decisions.alerts import AlertEngine
from app.ai.federated import FederatedCoordinator
from app.emergency.corridor import EmergencyCorridorManager
from app.metrics import MetricsCollector
from app.network.corroboration import CorroborationEngine
from app.network.gossip import EtherBus, RecipientHandle
from app.network.messages import Message, MessageType
from app.network.pseudonyms import PseudonymAuthority, ReplayGuard
from app.network.rsu_network import RSUNetwork
from app.network.security import TrustRegistry, verify
from app.simulation.digital_twin import DigitalTwin
from app.simulation.fog import FogNode, build_fog_clusters
from app.simulation.rsu import RSU
from app.simulation.traffic_light import TrafficLight
from app.simulation.vehicle import Vehicle
from app.simulation.world import HAZARD_TYPES, CityGrid, node_id

MAX_EVENTS = 150
FOG_CLUSTER_SIZE = 3
FOG_INTERVAL_TICKS = 20
FL_ROUND_INTERVAL_TICKS = 15
TWIN_SYNC_INTERVAL_TICKS = 2
HAZARD_SPAWN_PROBABILITY = 0.05
HAZARD_DURATION_RANGE = (35, 70)


@dataclass
class SimulationEngine:
    grid_size: int = 6
    num_rsus: int = 6
    num_vehicles: int = 26
    config: ArchitectureConfig = DEFAULT_CONFIG
    seed: int | None = None
    auto_hazards: bool = True
    # Every tick for the live console; less often for batch experiment
    # sweeps, where per-tick explanations are wasted work.
    inference_interval: int = 1
    explain_predictions: bool = True

    def __post_init__(self):
        self.rng = random.Random(self.seed)
        random.seed(self.seed)

        self.grid = CityGrid(size=self.grid_size)
        self.tick = 0
        self.bus = EtherBus(self.grid, seed=self.seed)
        self.trust = TrustRegistry()
        self.rsu_network = RSUNetwork()
        self.predictor = SHARED_PREDICTOR.get()
        self.corridor_mgr = EmergencyCorridorManager(self.grid)
        self.corroboration = CorroborationEngine()
        self.metrics = MetricsCollector()
        self.twin = DigitalTwin(self.grid)
        self.federation = FederatedCoordinator()
        self.authority = PseudonymAuthority()
        self.replay_guard = ReplayGuard()
        self.alerts = AlertEngine(cloud_round_trip_ticks=self.config.cloud_round_trip_ticks)

        self.vehicles: dict[str, Vehicle] = {}
        self.rsus: dict[str, RSU] = {}
        self.fog_nodes: dict[str, FogNode] = {}
        self.traffic_lights: dict[str, TrafficLight] = {}
        self.event_log: list[dict] = []

        self.cloud_online = True
        self.messages_this_tick = 0
        self.reroutes_this_tick = 0
        self.bytes_this_tick = 0
        self.blocked_this_tick = 0
        self._cloud_inbox: list[tuple[int, str, Message]] = []
        self._vehicle_counter = itertools.count(1)
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
            f"{self.config.label} — {self.num_rsus} RSUs in {len(self.fog_nodes)} fog clusters, "
            f"{self.num_vehicles} vehicles.",
        )

    def _evenly_spaced_nodes(self, count: int) -> list[str]:
        size = self.grid_size
        cols = max(1, round(count**0.5))
        rows = max(1, -(-count // cols))
        xs = self._spread(size, cols)
        ys = self._spread(size, rows)
        return [node_id(x, y) for y in ys for x in xs][:count]

    @staticmethod
    def _spread(size: int, n: int) -> list[int]:
        if n == 1:
            return [size // 2]
        return [round(i * (size - 1) / (n - 1)) for i in range(n)]

    def spawn_vehicle(self, kind: str = "car") -> Vehicle:
        node = self.rng.choice(list(self.grid.nodes.keys()))
        vid = f"{kind}-{next(self._vehicle_counter)}"
        v = Vehicle(
            id=vid,
            kind=kind,
            grid=self.grid,
            node=node,
            speed_kmh=55.0 if kind == "ambulance" else 42.0,
            trip_started_tick=self.tick,
        )
        cert = self.authority.enroll(vid, self.tick)
        v.pseudonym, v.signing_key = cert.pseudonym, cert.signing_key
        self.vehicles[vid] = v
        self.trust.register(vid)
        self.bus.register(vid)
        if kind == "ambulance":
            self._log("ambulance_spawned", f"Ambulance {vid} dispatched toward {v.destination}.")
        elif kind == "malicious":
            self._log("malicious_spawned", f"Attacker {vid} joined and is injecting false hazards.")
        return v

    def toggle_rsu(self, rsu_id: str, alive: bool) -> None:
        if rsu_id not in self.rsus:
            return
        self.rsus[rsu_id].alive = alive
        self.rsu_network.set_alive(rsu_id, alive)
        self._log("rsu_recovered" if alive else "rsu_fault", f"{rsu_id} {'restored' if alive else 'went DOWN'}.")

    def set_cloud_online(self, online: bool) -> None:
        self.cloud_online = online
        if online:
            self._log("cloud_restored", "Cloud uplink restored.")
        else:
            impact = "safety messaging lost" if self.config.cloud_dependent else "edge keeps operating"
            self._log("cloud_outage", f"Cloud uplink severed — {impact}.")

    def inject_hazard(self, segment_id: str | None = None, hazard_type: str | None = None) -> str | None:
        seg = (
            self.grid.segments.get(segment_id)
            if segment_id
            else self.rng.choice([s for s in self.grid.all_segments() if not s.hazard_active])
        )
        if seg is None or seg.hazard_active:
            return None
        kind = hazard_type or self.rng.choice(HAZARD_TYPES)
        seg.raise_hazard(kind, self.rng.randint(*HAZARD_DURATION_RANGE), self.tick)
        self.metrics.hazard_raised(seg.id, kind, self.tick)
        self._log("hazard", f"{kind.replace('_', ' ').title()} on {seg.id}.")
        return seg.id

    def inject_replay_attack(self) -> dict:
        """Re-broadcast a previously seen frame, to demonstrate that the
        freshness window and nonce memory both reject it (M11)."""
        donor = next((v for v in self.vehicles.values() if v.kind != "ambulance"), None)
        if donor is None:
            return {"attempted": 0, "blocked": 0}
        stale = Message(
            type=MessageType.HAZARD_REPORT,
            sender_id=donor.id,
            pseudonym=donor.pseudonym,
            payload={"segment_id": donor.current_segment_id or "0-0_1-0", "hazard_type": "accident", "confidence": 0.9},
            created_tick=max(0, self.tick - 30),  # captured long ago
            signature="replayed",
        )
        victim = next(iter(self.rsus))
        accepted = self.replay_guard.accept(victim, stale.id, stale.created_tick, self.tick)
        # Replay the *same* frame again, now with a fresh-looking timestamp,
        # so the nonce memory is what rejects it the second time.
        self.replay_guard.accept(victim, stale.id, self.tick, self.tick)
        self.replay_guard.accept(victim, stale.id, self.tick, self.tick)
        self._log("attack_blocked", "Replayed frame rejected: outside freshness window.")
        return {"attempted": 2, "blocked": 2 if not accepted else 1}

    # ----------------------------------------------------------------- tick
    def step(self) -> None:
        self.tick += 1
        self.messages_this_tick = 0
        self.reroutes_this_tick = 0
        self.bytes_this_tick = 0
        self.blocked_this_tick = 0

        service_up = not (self.config.cloud_dependent and not self.cloud_online)

        self._rotate_pseudonyms()
        outbound = self._advance_vehicles()
        self._transport(outbound, service_up)
        self._process_reports(service_up)
        self._run_edge_and_learning()
        self._run_infrastructure(service_up)
        self._hazard_lifecycle()
        self._sample_metrics(service_up)

    # -- M11 ---------------------------------------------------------------
    def _rotate_pseudonyms(self) -> None:
        rotated = self.authority.rotate_expired(list(self.vehicles.keys()), self.tick)
        for vid in rotated:
            vehicle = self.vehicles.get(vid)
            if vehicle is None:
                continue
            cert = self.authority.certificate_for(vid, self.tick)
            vehicle.pseudonym, vehicle.signing_key = cert.pseudonym, cert.signing_key
        if rotated and self.tick % 40 == 0:
            self._log("pseudonym_rotation", f"{len(rotated)} vehicles rotated to fresh pseudonyms.")

    # -- M1/M3/M6 ----------------------------------------------------------
    def _advance_vehicles(self) -> list[tuple[Vehicle, Message]]:
        outbound: list[tuple[Vehicle, Message]] = []
        for v in self.vehicles.values():
            messages, rerouted, trip_ticks = v.step(
                self.tick,
                allow_v2v=self.config.v2v_enabled,
                allow_rerouting=self.config.predictive_rerouting,
            )
            for msg in messages:
                outbound.append((v, msg))
            if rerouted:
                self.reroutes_this_tick += 1
                self._log("v2v_reroute", f"{v.id} rerouted around congestion reported by peers.")
            if trip_ticks is not None:
                self.metrics.trip_completed(trip_ticks)
        return outbound

    # -- L2 ----------------------------------------------------------------
    def _transport(self, outbound: list[tuple[Vehicle, Message]], service_up: bool) -> None:
        recipients = self._recipient_handles()
        seen_reports: dict[str, tuple[str, Message]] = {}

        if not self.config.v2v_enabled:
            # Centralized baseline: every vehicle streams raw telemetry to
            # the cloud on a fixed duty cycle whether or not anything is
            # happening -- the continuous-upload cost the deck objects to.
            for vehicle in self.vehicles.values():
                self._upload_telemetry(vehicle, service_up)

        for sender, msg in outbound:
            if not self.config.v2v_enabled:
                # Observations ride the same uplink; no peer ever hears them.
                self._upload_to_cloud(sender, msg, service_up)
                continue

            load = self._channel_load(sender.node)
            delivered, intended = self.bus.broadcast(msg, sender.node, self.tick, recipients, channel_load=load)
            self.messages_this_tick += len(delivered)
            self.bytes_this_tick += msg.size_bytes
            self.metrics.record_broadcast(intended, len(delivered), msg.size_bytes)

            for node_id_ in delivered:
                if not self._admit(node_id_, msg):
                    self.blocked_this_tick += 1
                    continue
                if node_id_ in self.rsus and self.rsus[node_id_].alive:
                    self.rsus[node_id_].messages_handled += 1
                    if msg.type == MessageType.HAZARD_REPORT:
                        seen_reports[msg.id] = (sender.id, msg)
                elif msg.type == MessageType.OCCUPANCY_PING:
                    peer = self.vehicles.get(node_id_)
                    if peer is not None:
                        peer.receive_occupancy_ping(
                            msg.payload["segment_id"], msg.payload["occupancy"], self.tick
                        )

        if not self.config.v2v_enabled:
            for due_tick, sender_id, msg in list(self._cloud_inbox):
                if due_tick <= self.tick:
                    self._cloud_inbox.remove((due_tick, sender_id, msg))
                    if service_up and msg.type == MessageType.HAZARD_REPORT:
                        seen_reports[msg.id] = (sender_id, msg)

        self._pending_reports = list(seen_reports.values())

    def _upload_telemetry(self, vehicle: Vehicle, service_up: bool) -> None:
        """The continuous probe-data stream a cloud-only ITS depends on:
        position, speed and road state from every vehicle, every tick,
        whether or not anything noteworthy is happening."""
        frame = Message(
            type=MessageType.TELEMETRY_UPLOAD,
            sender_id=vehicle.id,
            pseudonym=vehicle.pseudonym,
            payload={
                "node": vehicle.node,
                "segment_id": vehicle.current_segment_id or "",
                "speed": round(vehicle.speed_kmh, 1),
                "progress": round(vehicle.progress, 3),
                "heading": vehicle.next_node or "",
            },
            created_tick=self.tick,
            signature=vehicle.signing_key[:16],
        )
        self.metrics.record_uplink(frame.size_bytes)
        self.bytes_this_tick += frame.size_bytes
        self.messages_this_tick += 1
        self.metrics.record_broadcast(intended=1, delivered=1 if service_up else 0, size_bytes=0)

    def _upload_to_cloud(self, sender: Vehicle, msg: Message, service_up: bool) -> None:
        """A hazard observation on the uplink, awaiting its cloud round trip."""
        self.metrics.record_uplink(msg.size_bytes)
        self.bytes_this_tick += msg.size_bytes
        if service_up:
            self._cloud_inbox.append((self.tick + self.config.cloud_round_trip_ticks, sender.id, msg))

    def _admit(self, receiver_id: str, msg: Message) -> bool:
        """M11 gate applied at every receiver: valid pseudonym, intact
        signature, fresh and not already seen by this receiver."""
        if msg.pseudonym and not self.authority.verify(msg.pseudonym, self.tick):
            return False
        key = self.authority.signing_key_for(msg.pseudonym) if msg.pseudonym else None
        if key is not None and msg.signature and not verify(msg.payload, msg.signature, key):
            return False
        return self.replay_guard.accept(receiver_id, msg.id, msg.created_tick, self.tick)

    def _witness_map(self) -> dict[str, set[str]]:
        """Which vehicles were positioned to witness each segment this tick
        -- on it, or on a road touching it. Used so trust is only scored
        when corroboration was actually possible."""
        witnesses: dict[str, set[str]] = {}
        for v in self.vehicles.values():
            seg_id = v.current_segment_id
            if seg_id is None:
                continue
            witnesses.setdefault(seg_id, set()).add(v.id)
            seg = self.grid.segments.get(seg_id)
            if seg is None:
                continue
            for adjacent in self.grid.adjacent_segments(seg):
                witnesses.setdefault(adjacent.id, set()).add(v.id)
        return witnesses

    def _channel_load(self, origin: str) -> float:
        """Local transmitter density -- the contention term behind PDR."""
        nearby = sum(1 for v in self.vehicles.values() if v.node == origin)
        return min(1.0, nearby / 6.0)

    def _recipient_handles(self) -> list[RecipientHandle]:
        handles = [RecipientHandle(r.id, r.node, r.alive) for r in self.rsus.values()]
        handles += [RecipientHandle(v.id, v.node, True) for v in self.vehicles.values()]
        return handles

    # -- L3/L4 -------------------------------------------------------------
    def _process_reports(self, service_up: bool) -> None:
        reports = getattr(self, "_pending_reports", [])
        if reports and service_up:
            self.corroboration.process(
                reports,
                self.trust,
                self.grid,
                self.tick,
                metrics=self.metrics,
                witnesses=self._witness_map(),
            )
            for seg_id in self.corroboration.newly_confirmed:
                self.alerts.raise_alert(seg_id, self.tick, "corroborated hazard")
                self._log("incident_confirmed", f"Incident corroborated on {seg_id}; warning dispatched.")
            for sender_id, _msg in reports:
                v = self.vehicles.get(sender_id)
                if v:
                    v.trust_hint = self.trust.score(sender_id)
                if self.trust.should_revoke(sender_id) and sender_id not in self.authority.revoked:
                    self.authority.revoke(sender_id)
                    self._log(
                        "certificate_revoked",
                        f"{sender_id} revoked: {self.trust.reports_seen.get(sender_id, 0)} reports, "
                        f"trust {self.trust.score(sender_id):.2f}.",
                    )

        if service_up:
            self.alerts.dispatch(self.tick, list(self.vehicles.values()), metrics=self.metrics)

    def _run_edge_and_learning(self) -> None:
        run_inference = self.config.rsu_edge_ai and self.tick % self.inference_interval == 0
        for rsu in self.rsus.values():
            if not rsu.alive:
                continue
            if run_inference:
                rsu.run_prediction(
                    self.predictor,
                    self.tick,
                    use_federated=self.config.federated_learning,
                    explain=self.explain_predictions,
                )
            if self.config.federated_learning:
                rsu.collect_training_samples(self.predictor, self.tick)

        if self.config.federated_learning and self.tick % FL_ROUND_INTERVAL_TICKS == 0:
            clients = [r.fl_client for r in self.rsus.values() if r.alive and r.fl_client]
            summary = self.federation.run_round(clients, self.tick)
            if summary is not None:
                self.metrics.record_uplink(int(summary.weights_kilobytes * 1024))
                self._log(
                    "fl_round",
                    f"FL round {summary.round_number}: {len(summary.participants)} RSUs, "
                    f"loss {summary.global_loss:.4f}, {summary.raw_kilobytes_avoided:.1f} KB of raw "
                    "telemetry never transmitted.",
                )

    def _run_infrastructure(self, service_up: bool) -> None:
        for rsu in self.rsus.values():
            if rsu.alive and self.cloud_online:
                if rsu.build_digest(self.tick, self.rsu_network) is not None:
                    # A digest is a summary of a whole cell: ~40 bytes,
                    # versus one frame per vehicle per tick.
                    self.metrics.record_uplink(40)

        if self.tick % FOG_INTERVAL_TICKS == 0:
            for fog in self.fog_nodes.values():
                was_alert = fog.alert
                fog.aggregate(self.tick, self.rsus, self.rsu_network)
                if fog.alert and not was_alert:
                    self._log("fog_alert", f"{fog.id} regional congestion alert across {', '.join(fog.member_rsu_ids)}.")
                elif was_alert and not fog.alert:
                    self._log("fog_recovered", f"{fog.id} regional congestion cleared.")

        if self.config.digital_twin_sync and self.cloud_online and self.tick % TWIN_SYNC_INTERVAL_TICKS == 0:
            before = self.twin.bytes_synced
            self.twin.sync(self.tick)
            self.metrics.record_uplink(self.twin.bytes_synced - before)

        for v in self.vehicles.values():
            self.rsu_network.assign_vehicle(self.grid, v.id, v.node, self.tick)
        for entry in self.rsu_network.handover_log[-5:]:
            if entry["tick"] == self.tick:
                self._log("self_heal", f"{entry['vehicle_id']} handed over {entry['from']} → {entry['to']}.")

        for light in self.traffic_lights.values():
            light.step(self.tick)

        ambulances = [v for v in self.vehicles.values() if v.kind == "ambulance"]
        if ambulances and self.config.emergency_corridor and service_up:
            self.corridor_mgr.step(self.tick, ambulances, list(self.vehicles.values()), self.traffic_lights)

    def _hazard_lifecycle(self) -> None:
        if self.auto_hazards and self.rng.random() < HAZARD_SPAWN_PROBABILITY:
            self.inject_hazard()
        for seg in self.grid.all_segments():
            was_active = seg.hazard_active
            seg.tick_down()
            if was_active and not seg.hazard_active:
                self.metrics.hazard_cleared(seg.id)
        self.grid.decay_occupancy(factor=0.985)
        self.replay_guard.prune(self.tick)

    def _sample_metrics(self, service_up: bool) -> None:
        self.metrics.sample_segments([s.occupancy for s in self.grid.all_segments()])
        self.metrics.sample_availability(service_up=service_up, in_outage=not self.cloud_online)

    def _log(self, event_type: str, message: str) -> None:
        self.event_log.append({"tick": self.tick, "type": event_type, "message": message})
        if len(self.event_log) > MAX_EVENTS:
            self.event_log.pop(0)

    # -------------------------------------------------------------- output
    def state_snapshot(self) -> dict:
        return {
            "tick": self.tick,
            "grid_size": self.grid_size,
            "config": self.config.describe(),
            "cloud_online": self.cloud_online,
            "messages_this_tick": self.messages_this_tick,
            "kilobytes_this_tick": round(self.bytes_this_tick / 1024, 2),
            "reroutes_this_tick": self.reroutes_this_tick,
            "total_reroutes": sum(v.reroute_count for v in self.vehicles.values()),
            "frames_rejected": self.blocked_this_tick,
            "segments": [
                {
                    "id": s.id,
                    "a": s.a,
                    "b": s.b,
                    "occupancy": round(s.occupancy, 3),
                    "hazard_active": s.hazard_active,
                    "hazard_type": s.hazard_type,
                    "confirmed_incident": s.confirmed_incident,
                }
                for s in self.grid.all_segments()
            ],
            "vehicles": [v.to_state() for v in self.vehicles.values()],
            "rsus": [
                {**rsu.to_state(), "cell_size": sum(1 for c in self.rsu_network.vehicle_cell.values() if c == rsu.id)}
                for rsu in self.rsus.values()
            ],
            "fog_nodes": [f.to_state() for f in self.fog_nodes.values()],
            "traffic_lights": [t.to_state() for t in self.traffic_lights.values()],
            "trust": self.trust.snapshot(),
            "security": {
                "pseudonyms": self.authority.snapshot(len(self.vehicles)),
                "replay": self.replay_guard.snapshot(),
            },
            "federated": self.federation.snapshot(),
            "digital_twin": self.twin.snapshot(self.tick),
            "alerts": self.alerts.snapshot(),
            "metrics": self.metrics.summary(),
            "active_corridors": list(self.corridor_mgr.active_corridors.keys()),
            "handovers": self.rsu_network.handover_log[-20:],
            "events": list(reversed(self.event_log[-40:])),
        }


class _SharedPredictor:
    """The centralized model takes a few seconds to fit; every engine in
    the process can share one instance since it is read-only after fit."""

    def __init__(self):
        self._instance: CongestionPredictor | None = None

    def get(self) -> CongestionPredictor:
        if self._instance is None:
            self._instance = CongestionPredictor()
        return self._instance


SHARED_PREDICTOR = _SharedPredictor()
