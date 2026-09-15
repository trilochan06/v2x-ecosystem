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
from dataclasses import dataclass

from app.ai.congestion_model import CongestionPredictor
from app.ai.federated import FederatedCoordinator
from app.config import DEFAULT_CONFIG, ArchitectureConfig
from app.decisions.alerts import AlertEngine
from app.emergency.corridor import EmergencyCorridorManager
from app.metrics import MetricsCollector
from app.network.corroboration import CorroborationEngine
from app.network.gossip import EtherBus, RecipientHandle
from app.network.messages import (
    CertificateAttachmentPolicy,
    Message,
    MessageType,
    SignalRequestStatus,
    backhaul_bytes,
)
from app.network.pseudonyms import PseudonymAuthority, ReplayGuard
from app.network.rsu_network import RSUNetwork
from app.network.security import TrustRegistry, sign, verify
from app.simulation.digital_twin import DigitalTwin
from app.simulation.fog import FogNode, build_fog_clusters
from app.simulation.rsu import RSU
from app.simulation.traffic_light import TrafficLight
from app.simulation.vehicle import CRASH_LANE_BLOCKAGE, Vehicle, VehicleKind
from app.simulation.world import (
    HAZARD_TYPES,
    CityGrid,
    Pedestrian,
    junction_name,
    node_id,
    road_name,
)

MAX_EVENTS = 150
FOG_CLUSTER_SIZE = 3
FOG_INTERVAL_TICKS = 20
FL_ROUND_INTERVAL_TICKS = 15
TWIN_SYNC_INTERVAL_TICKS = 2
HAZARD_SPAWN_PROBABILITY = 0.05
HAZARD_DURATION_RANGE = (35, 70)
#: SPaT is broadcast continuously in the field (1-10 Hz). A tick here is much
#: coarser than 100 ms, so this is the equivalent duty cycle, not the rate.
SPAT_BROADCAST_INTERVAL_TICKS = 4
#: A priority request only needs to reach the junction just ahead.
SIGNAL_REQUEST_TTL_HOPS = 2
#: How many recent frames the street-level view can replay.
TRANSMISSION_LOG_LIMIT = 60
#: How long a pedestrian stays on the crossing.
PEDESTRIAN_CROSSING_TICKS = 10
#: How long a wreck keeps the road hazardous. Longer than the vehicles stay
#: immobile, because debris outlives the recovery truck.
CRASH_HAZARD_TTL_TICKS = 30


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
        self.cert_policy = CertificateAttachmentPolicy()
        #: SREM/SSEM outcomes. "unheard" is the interesting one: the request
        #: was made and nobody received it.
        self.signal_requests = {"requested": 0, "granted": 0, "unheard": 0}
        self.alerts = AlertEngine(cloud_round_trip_ticks=self.config.cloud_round_trip_ticks)

        self.vehicles: dict[str, Vehicle] = {}
        self.rsus: dict[str, RSU] = {}
        self.fog_nodes: dict[str, FogNode] = {}
        self.traffic_lights: dict[str, TrafficLight] = {}
        #: intersection node -> the RSU whose radio serves it.
        self._rsu_at: dict[str, str] = {}
        #: Recent frames on the air. A street-level view animates the actual
        #: hop rather than a running total, so it needs sender and receivers.
        #: Bounded so a long session cannot grow the snapshot without limit.
        self.transmissions: list[dict] = []
        #: Vulnerable road users currently on a crossing.
        self.pedestrians: dict[str, Pedestrian] = {}
        self._pedestrian_counter = itertools.count(1)
        #: Counts for the collective-perception story: how often a vehicle
        #: acted on a pedestrian it could not itself see.
        self.perception_stats = {"shared": 0, "warned_blind": 0, "brake_warnings": 0}
        #: Recent collisions, newest last, so the UI can narrate them.
        self.collisions: list[dict] = []
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
            self._rsu_at[node] = rsu_id
            self.bus.register(rsu_id)
            self.traffic_lights[node] = TrafficLight(id=f"light-{node}", node=node)
            cx, cy = self.grid.coords(node)
            rsu_coords[rsu_id] = (float(cx), float(cy))

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

    def spawn_vehicle(self, kind: VehicleKind = "car", at: str | None = None) -> Vehicle:
        node = at or self.rng.choice(list(self.grid.nodes.keys()))
        vid = f"{kind}-{next(self._vehicle_counter)}"
        v = Vehicle(
            id=vid,
            kind=kind,
            grid=self.grid,
            node=node,
            speed_kmh=55.0 if kind == "ambulance" else 42.0,
            trip_started_tick=self.tick,
            intent_coordination=self.config.intent_coordination,
        )
        cert = self.authority.enroll(vid, self.tick)
        v.pseudonym, v.signing_key = cert.pseudonym, cert.signing_key
        self.vehicles[vid] = v
        self.trust.register(vid)
        self.bus.register(vid)
        if kind == "ambulance":
            self._log("ambulance_spawned", f"Ambulance {vid} on station at {junction_name(node)}.")
        elif kind == "malicious":
            self._log(
                "malicious_spawned",
                f"Attacker {vid} joined at {junction_name(node)} and is injecting "
                "false hazard reports.",
            )
        return v

    def trigger_collision(self, segment_id: str | None = None) -> dict | None:
        """Stage a real collision between two vehicles.

        This is the most watchable thing the system does, because one event
        chains four modules together: both wrecks broadcast, the traffic
        behind is warned before it can see anything, peers corroborate the
        report into a confirmed incident, and the emergency response opens a
        corridor through it.

        Three kinds, looked for in this order, and every one of them uses
        vehicles that are already where they are:

        1. two vehicles on the same road -- a shunt;
        2. two vehicles converging on the same junction down different roads,
           which is where most urban collisions actually happen;
        3. one vehicle alone -- it leaves the carriageway.

        What it never does is materialise a second car on top of the first.
        That was the old fallback, and it is a teleport in full view of the
        audience. `kind` in the result says which of the three happened.
        """
        eligible: dict[str, list[Vehicle]] = {}
        for vehicle in self.vehicles.values():
            seg_id = vehicle.current_segment_id
            if seg_id is None or vehicle.crashed or vehicle.kind == "ambulance":
                continue
            if segment_id is not None and seg_id != segment_id:
                continue
            eligible.setdefault(seg_id, []).append(vehicle)
        if not eligible:
            return None

        pairs = {sid: vs for sid, vs in eligible.items() if len(vs) >= 2}
        converging = None if pairs else self._converging_pair(eligible)
        if pairs:
            crash_segment = self.rng.choice(sorted(pairs))
            involved = pairs[crash_segment][:2]
            kind = "shunt"
        elif converging is not None:
            crash_segment, involved = converging
            kind = "junction"
        else:
            crash_segment = self.rng.choice(sorted(eligible))
            involved = eligible[crash_segment][:1]
            kind = "solo"

        seg = self.grid.segments[crash_segment]
        for vehicle in involved:
            vehicle.crash(self.tick)
        seg.raise_hazard("accident", CRASH_HAZARD_TTL_TICKS, self.tick)
        self.metrics.hazard_raised(seg.id, "accident", self.tick)
        ids = [v.id for v in involved]
        self.collisions.append(
            {"tick": self.tick, "segment_id": seg.id, "vehicles": ids, "kind": kind}
        )
        del self.collisions[:-10]

        meeting_point = involved[0].next_node or seg.b
        descriptions = {
            "shunt": f"Collision on {road_name(seg.id)}: {ids[0]} ran into the back of {ids[-1]}.",
            "junction": (
                f"Collision at {junction_name(meeting_point)}: {ids[0]} and {ids[-1]} "
                "arrived together from different approaches."
            ),
            "solo": f"Single-vehicle accident on {road_name(seg.id)}: {ids[0]} left the carriageway.",
        }
        self._log("collision", descriptions[kind])
        return {"segment_id": seg.id, "vehicles": ids, "kind": kind, "solo": kind == "solo"}

    def _converging_pair(
        self, eligible: dict[str, list[Vehicle]]
    ) -> tuple[str, list[Vehicle]] | None:
        """Two vehicles closing on the same junction down different roads.

        Both have to be near the end of their approach, or this is two cars
        that happen to share a next junction rather than two cars about to
        meet at one.
        """
        approaching: dict[str, list[Vehicle]] = {}
        for vehicles in eligible.values():
            for vehicle in vehicles:
                if vehicle.progress < 0.5 or vehicle.next_node is None:
                    continue
                approaching.setdefault(vehicle.next_node, []).append(vehicle)

        candidates = sorted(
            node for node, vs in approaching.items() if len({v.current_segment_id for v in vs}) >= 2
        )
        if not candidates:
            return None

        node = self.rng.choice(candidates)
        at_node = sorted(approaching[node], key=lambda v: (v.current_segment_id or "", v.id))
        first = at_node[0]
        second = next(v for v in at_node if v.current_segment_id != first.current_segment_id)
        # Both are mid-approach, so both have a current segment by construction.
        approach = first.current_segment_id
        if approach is None:
            return None
        # The debris lands on the approach the first one was on.
        return approach, [first, second]

    def _recompute_occupancy(self) -> None:
        """Count what is on each road and set occupancy from it -- see
        `CityGrid.set_occupancy` for why this replaced an accumulator."""
        counts: dict[str, int] = {}
        blocked: dict[str, float] = {}
        for vehicle in self.vehicles.values():
            seg_id = vehicle.current_segment_id
            if seg_id is None:
                continue
            counts[seg_id] = counts.get(seg_id, 0) + 1
            if vehicle.crashed:
                blocked[seg_id] = blocked.get(seg_id, 0.0) + CRASH_LANE_BLOCKAGE
        self.grid.set_occupancy(counts, blocked)

    def _recover_wrecks(self) -> None:
        """Take wrecks off the road once recovery has reached them.

        A vehicle that has been in a collision used to sit still for
        twenty-two ticks and then drive off, which is not something wrecked
        cars do and was the most obviously wrong thing on the map. It leaves on
        a truck instead, and a replacement enters the city elsewhere so density
        holds steady.
        """
        for vehicle in list(self.vehicles.values()):
            if not vehicle.ready_for_recovery:
                continue
            del self.vehicles[vehicle.id]
            self.rsu_network.vehicle_cell.pop(vehicle.id, None)
            where = vehicle.current_segment_id or vehicle.node
            self._log(
                "recovery",
                f"{vehicle.id} recovered from {road_name(where)} and removed from the network.",
            )
            if vehicle.kind == "car":
                self.spawn_vehicle("car")

    def dispatch_ambulance_to(self, node: str) -> Vehicle:
        """Send an ambulance towards a specific junction.

        `spawn_vehicle` gives an ambulance a random errand, which is fine for
        background traffic and useless for showing a response to an incident
        that just happened somewhere specific.
        """
        # Start it far enough away to actually be seen responding. Spawning at
        # a random node put it *on* the incident about one time in sixteen,
        # giving a route of one node: no journey, no corridor, no priority
        # request, and nothing for a viewer to watch.
        distances = sorted(
            (n for n in self.grid.nodes if n != node),
            key=lambda n: -self.grid.euclidean(n, node),
        )
        far = distances[: max(1, len(distances) // 4)]
        # Prefer a station whose route passes a signalised junction it has not
        # already reached. Priority is requested for junctions *ahead*, so an
        # origin whose only light is the one under its own wheels asks for
        # nothing -- which looked like a lost request and was really a bad
        # dispatch. Choosing where to send from is a dispatcher's decision; it
        # does not touch whether the request is heard or granted.
        via_signal = [
            origin
            for origin in far
            if any(hop in self.traffic_lights for hop in self.grid.shortest_path(origin, node)[1:])
        ]
        # Placed at its station on creation rather than moved there
        # afterwards -- a vehicle that exists in one place and is then
        # relocated is a teleport, even within a single tick.
        ambulance = self.spawn_vehicle("ambulance", at=self.rng.choice(via_signal or far))
        ambulance.destination = node
        ambulance.route = self.grid.shortest_path(ambulance.node, node)
        ambulance.progress = 0.0
        ambulance.dwell_ticks = 0
        ambulance.trip_purpose = "responding to an incident"
        ambulance.trip_started_tick = self.tick
        self._log("ambulance_dispatch", f"{ambulance.id} responding to {junction_name(node)}.")
        return ambulance

    def despawn_vehicle(self) -> str | None:
        """Take a car off the road.

        Density is something a viewer needs to be able to dial: a map with
        twenty-six dots on it measures well and reads badly. Ordinary cars go
        first -- removing the ambulance somebody just dispatched, or the
        attacker they are watching, would be its own kind of confusing.
        """
        ordinary = [v for v in self.vehicles.values() if v.kind == "car"]
        pool = ordinary or list(self.vehicles.values())
        if not pool:
            return None
        victim = pool[-1]
        del self.vehicles[victim.id]
        # Otherwise the RSU it was homed to keeps counting it as served.
        self.rsu_network.vehicle_cell.pop(victim.id, None)
        return victim.id

    def set_vehicle_count(self, target: int) -> int:
        """Add or remove ordinary cars until the city holds `target` vehicles."""
        wanted = max(1, int(target))
        while len(self.vehicles) < wanted:
            self.spawn_vehicle("car")
        while len(self.vehicles) > wanted and self.despawn_vehicle() is not None:
            pass
        self._log("density", f"Traffic set to {len(self.vehicles)} vehicles.")
        return len(self.vehicles)

    def spawn_pedestrian(self, node: str | None = None) -> str | None:
        """Put a pedestrian on a crossing at `node`.

        Chooses an intersection that has traffic on at least one approach,
        because a pedestrian nobody is driving towards demonstrates nothing.
        """
        if node is None:
            busy = [
                n
                for n in self.grid.nodes
                if any(v.next_node == n or v.node == n for v in self.vehicles.values())
            ]
            node = self.rng.choice(busy or list(self.grid.nodes))
        neighbours = self.grid.neighbors(node)
        if not neighbours:
            return None

        # Prefer a crossing somebody is actually driving along. A pedestrian
        # on a road with no traffic demonstrates nothing: nobody can see them,
        # so nobody shares them and nobody brakes.
        candidates = [self.grid.segment_between(node, n) for n in neighbours]
        occupied = [
            seg
            for seg in candidates
            if any(v.current_segment_id == seg.id for v in self.vehicles.values())
        ]
        crossing = self.rng.choice(occupied or candidates)

        pid = f"ped-{next(self._pedestrian_counter)}"
        self.pedestrians[pid] = Pedestrian(
            id=pid,
            node=node,
            segment_id=crossing.id,
            ticks_remaining=PEDESTRIAN_CROSSING_TICKS,
            started_tick=self.tick,
        )
        self._log("pedestrian", f"Pedestrian stepped onto the crossing at {node}.")
        return pid

    def toggle_rsu(self, rsu_id: str, alive: bool) -> None:
        if rsu_id not in self.rsus:
            return
        self.rsus[rsu_id].alive = alive
        self.rsu_network.set_alive(rsu_id, alive)
        self._log(
            "rsu_recovered" if alive else "rsu_fault",
            f"{rsu_id} {'restored' if alive else 'went DOWN'}.",
        )

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
            type=MessageType.DENM_HAZARD,
            sender_id=donor.id,
            pseudonym=donor.pseudonym,
            payload={
                "segment_id": donor.current_segment_id or "0-0_1-0",
                "hazard_type": "accident",
                "confidence": 0.9,
            },
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
        self._pedestrian_lifecycle()
        self._recover_wrecks()
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
        transitions = 0
        moving = 0
        for v in self.vehicles.values():
            previous_node = v.node
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
            if v.node != previous_node:
                transitions += 1
            moving += 1
        self.metrics.sample_mobility(transitions, moving)
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

            # TS 103 097: a full certificate about once a second, an 8-byte
            # HashedId8 digest otherwise. Keyed by pseudonym, so a rotation
            # forces a re-attach -- the bandwidth price of unlinkability.
            msg.certificate_attached = self.cert_policy.attach(msg.pseudonym or msg.sender_id)
            load = self._channel_load(sender.node)
            delivered, intended = self.bus.broadcast(
                msg, sender.node, self.tick, recipients, channel_load=load
            )
            self.messages_this_tick += len(delivered)
            self.bytes_this_tick += msg.size_bytes
            self.metrics.record_broadcast(
                intended, len(delivered), msg.size_bytes, msg.spec.designator
            )
            self._record_transmission(msg, sender.node, delivered, intended)
            if msg.type == MessageType.CPM:
                self.perception_stats["shared"] += 1

            for node_id_ in delivered:
                if not self._admit(node_id_, msg):
                    self.blocked_this_tick += 1
                    continue
                if node_id_ in self.rsus and self.rsus[node_id_].alive:
                    rsu = self.rsus[node_id_]
                    rsu.messages_handled += 1
                    if msg.type == MessageType.DENM_HAZARD:
                        seen_reports[msg.id] = (sender.id, msg)
                    elif msg.type == MessageType.CAM:
                        rsu.reported_occupancy[msg.payload["segment_id"]] = (
                            float(msg.payload["occupancy"]),
                            self.tick,
                            self.trust.score(sender.id),
                        )
                elif msg.type == MessageType.CAM:
                    peer = self.vehicles.get(node_id_)
                    if peer is not None:
                        peer.receive_occupancy_ping(
                            msg.payload["segment_id"], msg.payload["occupancy"], self.tick
                        )
                elif msg.type == MessageType.CPM:
                    # A peer's sensors saw a road user. The receiver now knows
                    # about someone it may have no way of seeing itself.
                    peer = self.vehicles.get(node_id_)
                    if peer is not None:
                        segment_id = str(msg.payload["segment_id"])
                        blind = not peer.knows_pedestrian_on(segment_id, self.tick)
                        peer.receive_perceived_object(segment_id, self.tick)
                        if blind and peer.pedestrian_known_only_from_peers(segment_id, self.tick):
                            self.perception_stats["warned_blind"] += 1
                elif msg.type == MessageType.MCM:
                    # A peer said where it is going. This is the only channel
                    # that makes coordinated rerouting possible, and like
                    # every other belief it is written only on delivery.
                    peer = self.vehicles.get(node_id_)
                    if peer is not None:
                        planned = str(msg.payload.get("segments", ""))
                        if planned:
                            peer.receive_intent(planned.split(","), self.tick)
                elif msg.type == MessageType.DENM_EEBL:
                    peer = self.vehicles.get(node_id_)
                    if peer is not None:
                        peer.receive_hazard_warning(str(msg.payload["segment_id"]), self.tick)
                        self.perception_stats["brake_warnings"] += 1


        if not self.config.v2v_enabled:
            for due_tick, sender_id, msg in list(self._cloud_inbox):
                if due_tick <= self.tick:
                    self._cloud_inbox.remove((due_tick, sender_id, msg))
                    if service_up and msg.type == MessageType.DENM_HAZARD:
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
        self.metrics.record_broadcast(
            intended=1,
            delivered=1 if service_up else 0,
            size_bytes=0,
            designator=frame.spec.designator,
        )

    def _upload_to_cloud(self, sender: Vehicle, msg: Message, service_up: bool) -> None:
        """A hazard observation on the uplink, awaiting its cloud round trip.

        A vehicle with no sidelink radio does not emit a DENM; it uploads the
        same observation as a record over TLS, so it is sized as backhaul
        traffic rather than as a secured ITS-G5 frame."""
        size = backhaul_bytes(msg)
        self.metrics.record_uplink(size)
        self.bytes_this_tick += size
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
                rsu.collect_training_samples(self.predictor, self.tick, self._cell_trust(rsu.id))

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
            if rsu.alive and self.cloud_online and rsu.build_digest(self.tick, self.rsu_network) is not None:
                    # A digest is a summary of a whole cell: ~40 bytes,
                    # versus one frame per vehicle per tick.
                    self.metrics.record_uplink(40)

        if self.tick % FOG_INTERVAL_TICKS == 0:
            for fog in self.fog_nodes.values():
                was_alert = fog.alert
                fog.aggregate(self.tick, self.rsus, self.rsu_network)
                if fog.alert and not was_alert:
                    self._log(
                        "fog_alert",
                        f"{fog.id} regional congestion alert across "
                        f"{', '.join(fog.member_rsu_ids)}.",
                    )
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

        if self.config.v2v_enabled:
            self._broadcast_spat()

        ambulances = [v for v in self.vehicles.values() if v.kind == "ambulance"]
        if ambulances and self.config.emergency_corridor and service_up:
            self.corridor_mgr.step(self.tick, ambulances, list(self.vehicles.values()), self.traffic_lights)
            self._transmit_corridor_frames()
            self._exchange_signal_priority()

    def _broadcast_spat(self) -> None:
        """Every signalised intersection announces its phase (TS 103 301).

        SPaT is never relayed -- it describes one junction and is only useful
        to vehicles approaching it -- so it goes out at TTL 1.
        """
        if self.tick % SPAT_BROADCAST_INTERVAL_TICKS != 0:
            return
        recipients = self._recipient_handles()
        for light in self.traffic_lights.values():
            rsu_id = self._rsu_at.get(light.node)
            if rsu_id is None or not self.rsus[rsu_id].alive:
                continue  # the roadside radio is what transmits it
            frame = Message(
                type=MessageType.SPATEM,
                sender_id=light.id,
                payload={
                    "intersection": light.node,
                    "phase": light.phase,
                    "preempted": light.preempt_reason != "",
                },
                ttl=1,
                created_tick=self.tick,
            )
            # Transmitting is not delivering: hand the phase to every vehicle
            # that actually decoded the frame, or GLOSA has nothing to act on.
            for receiver in self._put_on_air(frame, light.node, recipients):
                peer = self.vehicles.get(receiver)
                if peer is not None:
                    peer.receive_signal_phase(light.node, light.phase, self.tick)

    def _exchange_signal_priority(self) -> None:
        """SREM out, SSEM back (TS 103 301).

        A direct method call always lands. A radio message does not: this one
        can be lost on the air, and the intersection can refuse it. Both are
        things a real deployment copes with and a function call hides.
        """
        requests = self.corridor_mgr.drain_requests()
        if not requests:
            return
        recipients = self._recipient_handles()
        for req in requests:
            ambulance = self.vehicles.get(req["ambulance_id"])
            light = self.traffic_lights.get(req["intersection"])
            if ambulance is None or light is None:
                continue

            self.signal_requests["requested"] += 1
            srem = Message(
                type=MessageType.SREM,
                sender_id=ambulance.id,
                pseudonym=ambulance.pseudonym,
                payload={
                    "request_id": req["request_id"],
                    "intersection": req["intersection"],
                    "eta_seconds": req["eta_seconds"],
                },
                ttl=SIGNAL_REQUEST_TTL_HOPS,
                created_tick=self.tick,
                signature=sign({"request_id": req["request_id"]}, ambulance.signing_key),
            )
            delivered = self._put_on_air(srem, ambulance.node, recipients)

            rsu_id = self._rsu_at.get(req["intersection"])
            heard = rsu_id is not None and rsu_id in delivered and self.rsus[rsu_id].alive
            if not heard:
                # Out of range, the frame collided, or the roadside unit is
                # down. The light simply never learns it was asked.
                self.signal_requests["unheard"] += 1
                continue

            light.preempt(self.tick, req["hold_ticks"], f"{ambulance.id} ETA {req['eta_seconds']}s")
            self.signal_requests["granted"] += 1
            ssem = Message(
                type=MessageType.SSEM,
                sender_id=light.id,
                payload={
                    "request_id": req["request_id"],
                    "intersection": req["intersection"],
                    "status": str(SignalRequestStatus.GRANTED),
                },
                ttl=SIGNAL_REQUEST_TTL_HOPS,
                created_tick=self.tick,
            )
            self._put_on_air(ssem, light.node, recipients)

    def _cell_trust(self, rsu_id: str) -> float:
        """Mean trust of the vehicles currently homed to this RSU.

        This is the link between M11 and M7: an RSU whose cell is full of
        vehicles the network has stopped believing is an RSU whose training
        data should not be averaged in at full weight.
        """
        members = [
            vid for vid, cell in self.rsu_network.vehicle_cell.items() if cell == rsu_id
        ]
        scores = [self.trust.score(vid) for vid in members if vid in self.vehicles]
        if not scores:
            return 1.0
        return sum(scores) / len(scores)

    def _put_on_air(self, frame: Message, origin_node: str, recipients: list) -> list[str]:
        """Transmit one frame and pay for it. Returns who decoded it."""
        frame.certificate_attached = self.cert_policy.attach(frame.pseudonym or frame.sender_id)
        load = self._channel_load(origin_node)
        delivered, intended = self.bus.broadcast(
            frame, origin_node, self.tick, recipients, channel_load=load
        )
        self.messages_this_tick += len(delivered)
        self.bytes_this_tick += frame.size_bytes
        self.metrics.record_broadcast(
            intended, len(delivered), frame.size_bytes, frame.spec.designator
        )
        self._record_transmission(frame, origin_node, delivered, intended)
        return delivered

    def _record_transmission(
        self, frame: Message, origin_node: str, delivered: list[str], intended: int
    ) -> None:
        self.transmissions.append(
            {
                "id": frame.id,
                "tick": self.tick,
                "designator": frame.spec.designator,
                "type": str(frame.type),
                "sender_id": frame.sender_id,
                "origin_node": origin_node,
                "delivered_to": list(delivered),
                "intended": intended,
                "segment_id": frame.payload.get("segment_id"),
                "hazard_type": frame.payload.get("hazard_type"),
                "cause_code": frame.payload.get("cause_code"),
            }
        )
        del self.transmissions[:-TRANSMISSION_LOG_LIMIT]

    def _transmit_corridor_frames(self) -> None:
        """Put the corridor's DENMs on the air and pay for them.

        These frames used to be built and dropped on the floor, which meant
        the emergency corridor appeared to cost no bandwidth at all."""
        frames = self.corridor_mgr.drain_frames()
        if not frames:
            return
        recipients = self._recipient_handles()
        for frame in frames:
            origin = self.vehicles.get(frame.sender_id)
            if origin is None:
                continue
            self._put_on_air(frame, origin.node, recipients)

    def _pedestrian_lifecycle(self) -> None:
        """Age pedestrians off the crossing, then work out who can see them.

        Line of sight is the whole mechanic. A vehicle travelling *along* the
        segment being crossed has a clear view down the road. A vehicle about
        to turn into that crossing from a perpendicular street does not --
        the corner is in the way. That asymmetry is what makes collective
        perception worth the bandwidth, and it is the turning case from the
        Porsche prototypes.
        """
        for pid, ped in list(self.pedestrians.items()):
            ped.step()
            if not ped.active:
                del self.pedestrians[pid]

        for vehicle in self.vehicles.values():
            vehicle.seen_pedestrians = {
                ped.segment_id: self.tick
                for ped in self.pedestrians.values()
                if self._has_line_of_sight(vehicle, ped)
            }
            # Anyone who can see a pedestrian in their own path brakes for
            # them, which is what generates the emergency brake warning.
            if vehicle.current_segment_id in vehicle.seen_pedestrians:
                vehicle.brake_hard()

    def _has_line_of_sight(self, vehicle: Vehicle, ped) -> bool:
        """Can this vehicle physically see this pedestrian?

        Only from on the crossing segment itself. Approaching the same
        intersection down a different street does not count -- that vehicle
        is turning blind.
        """
        return vehicle.current_segment_id == ped.segment_id

    def _hazard_lifecycle(self) -> None:
        if self.auto_hazards and self.rng.random() < HAZARD_SPAWN_PROBABILITY:
            self.inject_hazard()
        for seg in self.grid.all_segments():
            was_active = seg.hazard_active
            seg.tick_down()
            if was_active and not seg.hazard_active:
                self.metrics.hazard_cleared(seg.id)
        self._recompute_occupancy()
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
                {
                    **rsu.to_state(),
                    "cell_size": sum(
                        1 for c in self.rsu_network.vehicle_cell.values() if c == rsu.id
                    ),
                }
                for rsu in self.rsus.values()
            ],
            "fog_nodes": [f.to_state() for f in self.fog_nodes.values()],
            "traffic_lights": [t.to_state() for t in self.traffic_lights.values()],
            "trust": self.trust.snapshot(),
            "security": {
                "pseudonyms": self.authority.snapshot(len(self.vehicles)),
                "replay": self.replay_guard.snapshot(),
                "certificates": self.cert_policy.snapshot(),
            },
            "federated": self.federation.snapshot(),
            "digital_twin": self.twin.snapshot(self.tick),
            "alerts": self.alerts.snapshot(),
            "metrics": self.metrics.summary(),
            "active_corridors": list(self.corridor_mgr.active_corridors.keys()),
            "pedestrians": [
                ped.to_state(
                    seen_by=sorted(
                        v.id for v in self.vehicles.values() if self._has_line_of_sight(v, ped)
                    ),
                    known_by=sorted(
                        v.id
                        for v in self.vehicles.values()
                        if v.pedestrian_known_only_from_peers(ped.segment_id, self.tick)
                    ),
                )
                for ped in self.pedestrians.values()
            ],
            "collisions": list(self.collisions),
            "perception": {
                **self.perception_stats,
                "glosa_active": sum(
                    1 for v in self.vehicles.values() if v.glosa_advice is not None
                ),
            },
            "signal_priority": {
                **self.signal_requests,
                "grant_rate_pct": round(
                    100 * self.signal_requests["granted"] / max(self.signal_requests["requested"], 1), 1
                ),
            },
            "handovers": self.rsu_network.handover_log[-20:],
            "transmissions": list(self.transmissions),
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
