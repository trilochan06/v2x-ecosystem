/** Metrics, architecture configs, and the tick orchestration.
 *  Ported from `backend/app/metrics.py`, `config.py`, `simulation/engine.py`. */
import { CongestionPredictor, FederatedCoordinator } from "./ai";
import {
  AlertEngine,
  DigitalTwin,
  EmergencyCorridorManager,
  FogNode,
  RSU,
  RSUNetwork,
  TrafficLight,
  Vehicle,
  VehicleKind,
  buildFogClusters,
} from "./agents";
import {
  CertificateAttachmentPolicy,
  CityGrid,
  HAZARD_TYPES,
  MESSAGE_SPECS,
  Message,
  Pedestrian,
  SIGNAL_REQUEST_STATUS,
  Rng,
  backhaulBytes,
  makeMessage,
  makeRng,
  messageBytes,
  nodeId,
} from "./core";
import {
  CorroborationEngine,
  EtherBus,
  INCIDENT_DURATION_TICKS,
  PseudonymAuthority,
  RecipientHandle,
  ReplayGuard,
  TrustRegistry,
} from "./network";
import type { ArchitectureConfigState, SimulationState, Transmission } from "../types";

// ------------------------------------------------------------ metrics
const CONGESTION_THRESHOLD = 0.7;
/** SPaT is broadcast continuously in the field (1-10 Hz). A tick here is much
 *  coarser than 100 ms, so this is the equivalent duty cycle, not the rate. */
const SPAT_BROADCAST_INTERVAL_TICKS = 4;
/** A priority request only needs to reach the junction just ahead. */
const SIGNAL_REQUEST_TTL_HOPS = 2;
/** How many recent frames the street-level view can replay. */
const TRANSMISSION_LOG_LIMIT = 60;
/** How long a pedestrian stays on the crossing. */
const PEDESTRIAN_CROSSING_TICKS = 10;
/** How long a wreck keeps the road hazardous. Longer than the vehicles stay
 *  immobile, because debris outlives the recovery truck. */
const CRASH_HAZARD_TTL_TICKS = 30;

export class MetricsCollector {
  packetsIntended = 0;
  packetsDelivered = 0;
  messagesSent = 0;
  localBytes = 0;
  uplinkBytes = 0;
  detectionLatencies: number[] = [];
  alertLatencies: number[] = [];
  // `tripTimes` only sees journeys that finish inside the run, which
  // over-samples short routes — a survivorship bias that makes the average
  // depend on the window length. segmentTransitions / vehicleTicks has no
  // such bias: every vehicle contributes every tick.
  tripTimes: number[] = [];
  segmentTransitions = 0;
  vehicleTicks = 0;
  congestedSamples = 0;
  segmentSamples = 0;
  truePositives = 0;
  falsePositives = 0;
  serviceUpTicks = 0;
  totalTicks = 0;
  outageTicks = 0;
  outageServiceUpTicks = 0;
  // The message mix by standard designator (CAM, DENM, probe). Which
  // standard frames dominate the air is the interesting part of the overhead
  // story, not just the total.
  framesByDesignator = new Map<string, number>();
  bytesByDesignator = new Map<string, number>();
  private episodes = new Map<string, { started: number; detected: number | null }>();
  private closed: { detected: number | null }[] = [];

  recordBroadcast(intended: number, delivered: number, sizeBytes: number, designator = "") {
    this.messagesSent += 1;
    this.packetsIntended += intended;
    this.packetsDelivered += delivered;
    this.localBytes += sizeBytes;
    if (designator) {
      this.framesByDesignator.set(designator, (this.framesByDesignator.get(designator) ?? 0) + 1);
      this.bytesByDesignator.set(designator, (this.bytesByDesignator.get(designator) ?? 0) + sizeBytes);
    }
  }

  recordUplink(sizeBytes: number) {
    this.uplinkBytes += sizeBytes;
  }

  hazardRaised(segmentId: string, tick: number) {
    this.episodes.set(segmentId, { started: tick, detected: null });
  }

  hazardCleared(segmentId: string) {
    const ep = this.episodes.get(segmentId);
    if (ep) {
      this.closed.push({ detected: ep.detected });
      this.episodes.delete(segmentId);
    }
  }

  incidentConfirmed(segmentId: string, tick: number, hazardActive: boolean) {
    if (!hazardActive) {
      this.falsePositives += 1;
      return;
    }
    this.truePositives += 1;
    const ep = this.episodes.get(segmentId);
    if (ep && ep.detected === null) {
      ep.detected = tick;
      this.detectionLatencies.push(tick - ep.started);
    }
  }

  alertDelivered(segmentId: string, tick: number) {
    const ep = this.episodes.get(segmentId);
    if (ep) this.alertLatencies.push(tick - ep.started);
  }

  tripCompleted(ticks: number) {
    this.tripTimes.push(ticks);
  }

  sampleMobility(transitions: number, vehicleTicks: number) {
    this.segmentTransitions += transitions;
    this.vehicleTicks += vehicleTicks;
  }

  sampleSegments(occupancies: number[]) {
    this.segmentSamples += occupancies.length;
    this.congestedSamples += occupancies.filter((o) => o >= CONGESTION_THRESHOLD).length;
  }

  sampleAvailability(serviceUp: boolean, inOutage: boolean) {
    this.totalTicks += 1;
    if (serviceUp) this.serviceUpTicks += 1;
    if (inOutage) {
      this.outageTicks += 1;
      if (serviceUp) this.outageServiceUpTicks += 1;
    }
  }

  summary() {
    const open = [...this.episodes.values()];
    const detected = this.closed.filter((e) => e.detected !== null).length + open.filter((e) => e.detected !== null).length;
    const missed = this.closed.filter((e) => e.detected === null).length + open.filter((e) => e.detected === null).length;

    const precision = ratio(this.truePositives, this.truePositives + this.falsePositives);
    const recall = ratio(detected, detected + missed);
    const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);

    return {
      communication: {
        packet_delivery_ratio: r4(ratio(this.packetsDelivered, this.packetsIntended)),
        avg_detection_latency_ticks: r2(mean(this.detectionLatencies)),
        avg_alert_latency_ticks: r2(mean(this.alertLatencies)),
        // Corroborated alerts are rare events; a mean over one or two of them
        // is noise, so the sample count travels with it.
        alert_samples: this.alertLatencies.length,
        detection_samples: this.detectionLatencies.length,
        messages_sent: this.messagesSent,
        local_kilobytes: r1(this.localBytes / 1024),
        local_kilobytes_per_tick: r3(this.localBytes / 1024 / Math.max(this.totalTicks, 1)),
        uplink_kilobytes: r1(this.uplinkBytes / 1024),
        uplink_kilobytes_per_tick: r3(this.uplinkBytes / 1024 / Math.max(this.totalTicks, 1)),
        frames_by_designator: Object.fromEntries(this.framesByDesignator),
        kilobytes_by_designator: Object.fromEntries(
          [...this.bytesByDesignator].map(([k, v]) => [k, r2(v / 1024)]),
        ),
      },
      traffic: {
        segments_per_100_vehicle_ticks: r3(100 * ratio(this.segmentTransitions, this.vehicleTicks)),
        segment_transitions: this.segmentTransitions,
        avg_trip_ticks: r2(mean(this.tripTimes)),
        trips_completed: this.tripTimes.length,
        congestion_duration_pct: r2(100 * ratio(this.congestedSamples, this.segmentSamples)),
      },
      detection: {
        precision: r4(precision),
        recall: r4(recall),
        f1: r4(f1),
        true_positives: this.truePositives,
        false_positives: this.falsePositives,
        hazards_detected: detected,
        hazards_missed: missed,
      },
      resilience: {
        availability_pct: r2(100 * ratio(this.serviceUpTicks, this.totalTicks)),
        availability_during_outage_pct: r2(100 * ratio(this.outageServiceUpTicks, this.outageTicks)),
        outage_ticks: this.outageTicks,
        total_ticks: this.totalTicks,
      },
    };
  }
}

const ratio = (n: number, d: number) => (d === 0 ? 0 : n / d);
const mean = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (v: number) => Math.round(v * 10) / 10;
const r2 = (v: number) => Math.round(v * 100) / 100;
const r3 = (v: number) => Math.round(v * 1000) / 1000;
const r4 = (v: number) => Math.round(v * 10000) / 10000;

// ------------------------------------------------------------- configs
export const CONFIGS: Record<string, ArchitectureConfigState> = {
  exp1_centralized: {
    key: "exp1_centralized",
    label: "Exp 1 — Centralized baseline (cloud only)",
    summary:
      "Vehicles are sensors that upload to the cloud; every decision makes a cloud round trip. No direct V2V, no edge inference. Losing the uplink means losing the service.",
    v2v_enabled: false,
    rsu_edge_ai: false,
    federated_learning: false,
    digital_twin_sync: true,
    predictive_rerouting: false,
    emergency_corridor: true,
    cloud_round_trip_ticks: 6,
    cloud_dependent: true,
  },
  exp2_v2x_no_edge_ai: {
    key: "exp2_v2x_no_edge_ai",
    label: "Exp 2 — V2X + RSU without edge intelligence",
    summary:
      "Direct V2V/V2I messaging works and RSUs aggregate traffic, but RSUs only forward — no local inference, no federated learning, no predictive traffic management.",
    v2v_enabled: true,
    rsu_edge_ai: false,
    federated_learning: false,
    digital_twin_sync: false,
    predictive_rerouting: true,
    emergency_corridor: true,
    cloud_round_trip_ticks: 3,
    cloud_dependent: false,
  },
  exp3_full: {
    key: "exp3_full",
    label: "Exp 3 — Full proposed architecture",
    summary:
      "Edge AI at every RSU, federated learning across the region, continuous digital twin synchronization, and peer-driven predictive rerouting. Safety messaging survives a cloud outage.",
    v2v_enabled: true,
    rsu_edge_ai: true,
    federated_learning: true,
    digital_twin_sync: true,
    predictive_rerouting: true,
    emergency_corridor: true,
    cloud_round_trip_ticks: 0,
    cloud_dependent: false,
  },
  // Exp 3 with one variable changed and nothing else, so any difference in the
  // results is attributable to intent coordination rather than to a bundle of
  // changes moving together. It ships disabled — see the README for why.
  exp4_coordinated: {
    key: "exp4_coordinated",
    label: "Exp 4 — Proposed + intent coordination",
    summary:
      "Exp 3, plus vehicles announcing where they intend to go (MCM) so a detour is priced by how many peers have already claimed it. Tests whether coordination beats the greedy rerouting that stampedes a platoon onto one alternative.",
    v2v_enabled: true,
    rsu_edge_ai: true,
    federated_learning: true,
    digital_twin_sync: true,
    predictive_rerouting: true,
    emergency_corridor: true,
    intent_coordination: true,
    cloud_round_trip_ticks: 0,
    cloud_dependent: false,
  },
};

// -------------------------------------------------------------- engine
const MAX_EVENTS = 150;
const FOG_INTERVAL_TICKS = 20;
const FL_ROUND_INTERVAL_TICKS = 15;
const TWIN_SYNC_INTERVAL_TICKS = 2;
const HAZARD_SPAWN_PROBABILITY = 0.05;

export interface EngineOptions {
  gridSize?: number;
  numRsus?: number;
  numVehicles?: number;
  config?: ArchitectureConfigState;
  seed?: number;
  autoHazards?: boolean;
  inferenceInterval?: number;
  explainPredictions?: boolean;
}

export class SimulationEngine {
  grid: CityGrid;
  tick = 0;
  config: ArchitectureConfigState;
  cloudOnline = true;
  vehicles = new Map<string, Vehicle>();
  rsus = new Map<string, RSU>();
  fogNodes = new Map<string, FogNode>();
  trafficLights = new Map<string, TrafficLight>();
  /** Vulnerable road users currently on a crossing. */
  pedestrians = new Map<string, Pedestrian>();
  /** How often collective perception and the brake light actually did
   *  something. `warnedBlind` is the one that matters: a vehicle acted on a
   *  pedestrian it could not itself see. */
  perceptionStats = { shared: 0, warnedBlind: 0, brakeWarnings: 0 };
  /** Recent collisions, newest last, so the UI can narrate them. */
  collisions: { tick: number; segment_id: string; vehicles: string[] }[] = [];
  metrics = new MetricsCollector();
  federation = new FederatedCoordinator();
  trust = new TrustRegistry();
  authority: PseudonymAuthority;
  replayGuard = new ReplayGuard();
  certPolicy = new CertificateAttachmentPolicy();
  /** SREM/SSEM outcomes. `unheard` is the interesting one: the request was
   *  made and nobody received it. */
  signalRequests = { requested: 0, granted: 0, unheard: 0 };
  /** intersection node -> the RSU whose radio serves it. */
  private rsuAt = new Map<string, string>();
  /** Recent frames on the air. The street-level view animates these, so it
   *  needs the actual hop rather than a running total. Bounded so a long
   *  session cannot grow the snapshot without limit. */
  transmissions: Transmission[] = [];
  twin: DigitalTwin;
  alerts: AlertEngine;
  corridor: EmergencyCorridorManager;
  corroboration = new CorroborationEngine();
  rsuNetwork = new RSUNetwork();
  predictor = new CongestionPredictor();
  eventLog: { tick: number; type: string; message: string }[] = [];

  private rng: Rng;
  private bus: EtherBus;
  private vehicleCounter = 1;
  private pedestrianCounter = 1;
  private cloudInbox: { due: number; senderId: string; msg: Message }[] = [];
  private messagesThisTick = 0;
  private bytesThisTick = 0;
  private reroutesThisTick = 0;
  private blockedThisTick = 0;
  private pendingReports: { senderId: string; msg: Message }[] = [];
  private readonly numRsus: number;
  private readonly autoHazards: boolean;
  private readonly inferenceInterval: number;
  private readonly explainPredictions: boolean;

  constructor(opts: EngineOptions = {}) {
    const gridSize = opts.gridSize ?? 6;
    this.numRsus = opts.numRsus ?? 6;
    this.config = opts.config ?? CONFIGS.exp3_full;
    this.autoHazards = opts.autoHazards ?? true;
    this.inferenceInterval = opts.inferenceInterval ?? 1;
    this.explainPredictions = opts.explainPredictions ?? true;

    this.rng = makeRng(opts.seed ?? 4242);
    this.grid = new CityGrid(gridSize);
    this.bus = new EtherBus(this.grid, this.rng);
    this.authority = new PseudonymAuthority(this.rng);
    this.twin = new DigitalTwin(this.grid);
    this.alerts = new AlertEngine(this.config.cloud_round_trip_ticks);
    this.corridor = new EmergencyCorridorManager(this.grid);

    this.spawnInitial(opts.numVehicles ?? 26);
  }

  private spawnInitial(numVehicles: number) {
    const coords = new Map<string, [number, number]>();
    for (const [i, node] of this.evenlySpacedNodes(this.numRsus).entries()) {
      const id = `rsu-${i + 1}`;
      this.rsus.set(id, new RSU(id, node, this.grid));
      this.rsuAt.set(node, id);
      this.rsuNetwork.register(id, node);
      this.bus.register(id);
      this.trafficLights.set(node, new TrafficLight(`light-${node}`, node));
      const [x, y] = this.grid.coords(node);
      coords.set(id, [x, y]);
    }
    for (const fog of buildFogClusters([...this.rsus.keys()], coords)) this.fogNodes.set(fog.id, fog);
    for (let i = 0; i < numVehicles; i++) this.spawnVehicle("car");

    this.log(
      "system_start",
      `${this.config.label} — ${this.numRsus} RSUs in ${this.fogNodes.size} fog clusters, ${numVehicles} vehicles.`,
    );
  }

  private evenlySpacedNodes(count: number): string[] {
    const size = this.grid.size;
    const cols = Math.max(1, Math.round(Math.sqrt(count)));
    const rows = Math.max(1, Math.ceil(count / cols));
    const spread = (n: number) =>
      n === 1 ? [Math.floor(size / 2)] : Array.from({ length: n }, (_, i) => Math.round((i * (size - 1)) / (n - 1)));
    const xs = spread(cols);
    const ys = spread(rows);
    const out: string[] = [];
    for (const y of ys) for (const x of xs) out.push(nodeId(x, y));
    return out.slice(0, count);
  }

  spawnVehicle(kind: VehicleKind = "car"): Vehicle {
    const node = this.rng.pick([...this.grid.nodes.keys()]);
    const id = `${kind}-${this.vehicleCounter++}`;
    const v = new Vehicle(id, kind, this.grid, node, kind === "ambulance" ? 55 : 42, this.rng, this.tick);
    v.intentCoordination = Boolean(this.config.intent_coordination);
    v.pseudonym = this.authority.enroll(id, this.tick).pseudonym;
    this.vehicles.set(id, v);
    this.trust.register(id);
    this.bus.register(id);
    if (kind === "ambulance") this.log("ambulance_spawned", `Ambulance ${id} dispatched toward ${v.destination}.`);
    if (kind === "malicious") this.log("malicious_spawned", `Attacker ${id} joined and is injecting false hazards.`);
    return v;
  }

  /**
   * Put a pedestrian on a crossing at `node`.
   *
   * Chooses an intersection that has traffic on at least one approach, because
   * a pedestrian nobody is driving towards demonstrates nothing: nobody can
   * see them, so nobody shares them and nobody brakes.
   */
  spawnPedestrian(node?: string): string | null {
    if (!node) {
      const busy = [...this.grid.nodes.keys()].filter((n) =>
        [...this.vehicles.values()].some((v) => v.nextNode === n || v.node === n),
      );
      node = this.rng.pick(busy.length ? busy : [...this.grid.nodes.keys()]);
    }
    const neighbours = this.grid.neighbors(node);
    if (!neighbours.length) return null;

    const candidates = neighbours.map((n) => this.grid.segmentBetween(node!, n));
    const occupied = candidates.filter((seg) =>
      [...this.vehicles.values()].some((v) => v.currentSegmentId === seg.id),
    );
    const crossing = this.rng.pick(occupied.length ? occupied : candidates);

    const pid = `ped-${this.pedestrianCounter++}`;
    this.pedestrians.set(pid, new Pedestrian(pid, node, crossing.id, PEDESTRIAN_CROSSING_TICKS, this.tick));
    this.log("pedestrian", `Pedestrian stepped onto the crossing at ${node}.`);
    return pid;
  }

  /**
   * Stage a real collision between two vehicles.
   *
   * This is the most watchable thing the system does, because one event
   * chains four modules together: both wrecks broadcast, the traffic behind
   * is warned before it can see anything, peers corroborate the report into a
   * confirmed incident, and the emergency response opens a corridor through
   * it.
   *
   * Prefers a road that genuinely has two vehicles on it. Only if no such
   * road exists does it place a second vehicle there, which is a demo
   * affordance rather than something traffic does — the returned `staged`
   * flag and the event log say which of the two happened.
   */
  triggerCollision(segmentId?: string): { segment_id: string; vehicles: string[]; staged: boolean } | null {
    const eligible = new Map<string, Vehicle[]>();
    for (const vehicle of this.vehicles.values()) {
      const segId = vehicle.currentSegmentId;
      if (!segId || vehicle.crashed || vehicle.kind === "ambulance") continue;
      if (segmentId && segId !== segmentId) continue;
      if (!eligible.has(segId)) eligible.set(segId, []);
      eligible.get(segId)!.push(vehicle);
    }

    const pairs = [...eligible.entries()].filter(([, vs]) => vs.length >= 2);
    let crashSegment: string;
    let first: Vehicle;
    let second: Vehicle;
    let staged = false;

    if (pairs.length) {
      const [segId, vs] = pairs[this.rng.int(0, pairs.length - 1)];
      crashSegment = segId;
      [first, second] = vs;
    } else if (eligible.size) {
      // Nobody is sharing a road. Bring a second vehicle onto one.
      const keys = [...eligible.keys()].sort();
      crashSegment = keys[this.rng.int(0, keys.length - 1)];
      first = eligible.get(crashSegment)![0];
      second = this.spawnVehicle("car");
      second.node = first.node;
      second.route = [...first.route];
      second.progress = Math.max(0, first.progress - 0.08);
      staged = true;
    } else {
      return null;
    }

    const seg = this.grid.segments.get(crashSegment)!;
    first.crash(this.tick);
    second.crash(this.tick);
    seg.raiseHazard("accident", CRASH_HAZARD_TTL_TICKS, this.tick);
    this.metrics.hazardRaised(seg.id, this.tick);
    this.collisions.push({ tick: this.tick, segment_id: seg.id, vehicles: [first.id, second.id] });
    if (this.collisions.length > 10) this.collisions.shift();

    const how = staged ? "a second vehicle was brought onto the road" : "two vehicles already there";
    this.log("collision", `Collision on ${seg.id} between ${first.id} and ${second.id} (${how}).`);
    return { segment_id: seg.id, vehicles: [first.id, second.id], staged };
  }

  /**
   * Send an ambulance towards a specific junction.
   *
   * `spawnVehicle` gives an ambulance a random errand, which is fine for
   * background traffic and useless for showing a response to an incident that
   * just happened somewhere specific.
   */
  dispatchAmbulanceTo(node: string): Vehicle {
    const ambulance = this.spawnVehicle("ambulance");
    // Start it far enough away to actually be seen responding. Spawning at a
    // random node put it *on* the incident about one time in sixteen, giving
    // a route of one node: no journey, no corridor, no priority request, and
    // nothing for a viewer to watch.
    const byDistance = [...this.grid.nodes.keys()]
      .filter((n) => n !== node)
      .sort((a, b) => this.grid.euclidean(b, node) - this.grid.euclidean(a, node));
    const far = byDistance.slice(0, Math.max(1, Math.floor(byDistance.length / 4)));
    // Prefer a station whose route passes a signalised junction it has not
    // already reached. Priority is requested for junctions *ahead*, so an
    // origin whose only light is the one under its own wheels asks for
    // nothing — which looked like a lost request and was really a bad
    // dispatch. Choosing where to send from is a dispatcher's decision; it
    // does not touch whether the request is heard or granted.
    const viaSignal = far.filter((origin) =>
      this.grid.shortestPath(origin, node).slice(1).some((hop) => this.trafficLights.has(hop)),
    );
    ambulance.node = this.rng.pick(viaSignal.length ? viaSignal : far);
    ambulance.destination = node;
    ambulance.route = this.grid.shortestPath(ambulance.node, node);
    ambulance.progress = 0;
    this.log("ambulance_dispatch", `${ambulance.id} responding to ${node}.`);
    return ambulance;
  }

  /**
   * Take a car off the road.
   *
   * Density is something the viewer needs to be able to dial: a map with
   * twenty-six dots on it measures well and reads badly. Ordinary cars go
   * first — removing the ambulance somebody just dispatched, or the attacker
   * they are watching, would be its own kind of confusing.
   */
  despawnVehicle(): string | null {
    const ordinary = [...this.vehicles.values()].filter((v) => v.kind === "car");
    const pool = ordinary.length ? ordinary : [...this.vehicles.values()];
    const victim = pool[pool.length - 1];
    if (!victim) return null;
    this.vehicles.delete(victim.id);
    // Otherwise the RSU it was homed to keeps counting it as served.
    this.rsuNetwork.vehicleCell.delete(victim.id);
    return victim.id;
  }

  /** Add or remove ordinary cars until the city holds `target` vehicles. */
  setVehicleCount(target: number) {
    const wanted = Math.max(1, Math.round(target));
    while (this.vehicles.size < wanted) this.spawnVehicle("car");
    while (this.vehicles.size > wanted && this.despawnVehicle()) {
      /* despawnVehicle returns null when there is nothing left to remove */
    }
    this.log("density", `Traffic set to ${this.vehicles.size} vehicles.`);
  }

  toggleRsu(rsuId: string, alive: boolean) {
    const rsu = this.rsus.get(rsuId);
    if (!rsu) return;
    rsu.alive = alive;
    this.rsuNetwork.setAlive(rsuId, alive);
    this.log(alive ? "rsu_recovered" : "rsu_fault", `${rsuId} ${alive ? "restored" : "went DOWN"}.`);
  }

  setCloudOnline(online: boolean) {
    this.cloudOnline = online;
    if (online) this.log("cloud_restored", "Cloud uplink restored.");
    else
      this.log(
        "cloud_outage",
        `Cloud uplink severed — ${this.config.cloud_dependent ? "safety messaging lost" : "edge keeps operating"}.`,
      );
  }

  injectHazard(segmentId?: string): string | null {
    const clear = this.grid.allSegments().filter((s) => !s.hazardActive);
    const seg = segmentId ? this.grid.segments.get(segmentId) : clear.length ? this.rng.pick(clear) : undefined;
    if (!seg || seg.hazardActive) return null;
    const kind = this.rng.pick(HAZARD_TYPES);
    seg.raiseHazard(kind, this.rng.int(35, 70), this.tick);
    this.metrics.hazardRaised(seg.id, this.tick);
    this.log("hazard", `${kind.replace(/_/g, " ")} on ${seg.id}.`);
    return seg.id;
  }

  /** Re-broadcast a captured frame to demonstrate that the freshness window
   *  and the nonce memory both reject it. */
  injectReplayAttack(): { attempted: number; blocked: number } {
    const victim = [...this.rsus.keys()][0];
    if (!victim) return { attempted: 0, blocked: 0 };
    const stale = makeMessage({
      type: "denm-hazard",
      senderId: "replayed",
      pseudonym: "",
      payload: { segment_id: "0-0_1-0", hazard_type: "accident", confidence: 0.9 },
      ttl: 1,
      createdTick: Math.max(0, this.tick - 30),
      signed: true,
    });
    const first = this.replayGuard.accept(victim, stale.id, stale.createdTick, this.tick);
    this.replayGuard.accept(victim, stale.id, this.tick, this.tick);
    this.replayGuard.accept(victim, stale.id, this.tick, this.tick);
    this.log("attack_blocked", "Replayed frame rejected: outside freshness window.");
    return { attempted: 2, blocked: first ? 1 : 2 };
  }

  step() {
    this.tick += 1;
    this.messagesThisTick = 0;
    this.bytesThisTick = 0;
    this.reroutesThisTick = 0;
    this.blockedThisTick = 0;

    const serviceUp = !(this.config.cloud_dependent && !this.cloudOnline);

    this.rotatePseudonyms();
    const outbound = this.advanceVehicles();
    this.transport(outbound, serviceUp);
    this.processReports(serviceUp);
    this.runEdgeAndLearning();
    this.runInfrastructure(serviceUp);
    this.pedestrianLifecycle();
    this.hazardLifecycle();

    this.metrics.sampleSegments(this.grid.allSegments().map((s) => s.occupancy));
    this.metrics.sampleAvailability(serviceUp, !this.cloudOnline);
  }

  private rotatePseudonyms() {
    const rotated = this.authority.rotateExpired([...this.vehicles.keys()], this.tick);
    for (const id of rotated) {
      const v = this.vehicles.get(id);
      if (v) v.pseudonym = this.authority.certificateFor(id, this.tick).pseudonym;
    }
    if (rotated.length && this.tick % 40 === 0)
      this.log("pseudonym_rotation", `${rotated.length} vehicles rotated to fresh pseudonyms.`);
  }

  private advanceVehicles(): { vehicle: Vehicle; msg: Message }[] {
    const outbound: { vehicle: Vehicle; msg: Message }[] = [];
    let transitions = 0;
    let moving = 0;
    for (const v of this.vehicles.values()) {
      const previousNode = v.node;
      const { outbound: msgs, rerouted, completedTrip } = v.step(
        this.tick,
        this.config.v2v_enabled,
        this.config.predictive_rerouting,
      );
      for (const msg of msgs) outbound.push({ vehicle: v, msg });
      if (rerouted) {
        this.reroutesThisTick += 1;
        this.log("v2v_reroute", `${v.id} rerouted around congestion reported by peers.`);
      }
      if (completedTrip !== null) this.metrics.tripCompleted(completedTrip);
      if (v.node !== previousNode) transitions += 1;
      moving += 1;
    }
    this.metrics.sampleMobility(transitions, moving);
    return outbound;
  }

  private transport(outbound: { vehicle: Vehicle; msg: Message }[], serviceUp: boolean) {
    const recipients = this.recipientHandles();
    const seen = new Map<string, { senderId: string; msg: Message }>();

    if (!this.config.v2v_enabled) {
      // Centralized baseline: every vehicle streams raw telemetry on a fixed
      // duty cycle whether or not anything is happening.
      for (const v of this.vehicles.values()) this.uploadTelemetry(v, serviceUp);
    }

    for (const { vehicle, msg } of outbound) {
      if (!this.config.v2v_enabled) {
        // A vehicle with no sidelink radio does not emit a DENM; it uploads
        // the same observation over TLS, so it is sized as backhaul traffic.
        const uplink = backhaulBytes(msg);
        this.metrics.recordUplink(uplink);
        this.bytesThisTick += uplink;
        if (serviceUp)
          this.cloudInbox.push({
            due: this.tick + this.config.cloud_round_trip_ticks,
            senderId: vehicle.id,
            msg,
          });
        continue;
      }

      // TS 103 097: a full certificate about once a second, an 8-byte
      // HashedId8 digest otherwise. Keyed by pseudonym, so a rotation forces
      // a re-attach -- the bandwidth price of unlinkability.
      msg.certificateAttached = this.certPolicy.attach(msg.pseudonym || msg.senderId);
      const load = this.channelLoad(vehicle.node);
      const { delivered, intended } = this.bus.broadcast(msg, vehicle.node, this.tick, recipients, load);
      const bytes = messageBytes(msg);
      this.messagesThisTick += delivered.length;
      this.bytesThisTick += bytes;
      this.metrics.recordBroadcast(intended, delivered.length, bytes, MESSAGE_SPECS[msg.type].designator);
      this.recordTransmission(msg, vehicle.node, delivered, intended);
      if (msg.type === "cpm") this.perceptionStats.shared += 1;

      for (const nodeIdent of delivered) {
        if (!this.admit(nodeIdent, msg)) {
          this.blockedThisTick += 1;
          continue;
        }
        const rsu = this.rsus.get(nodeIdent);
        if (rsu?.alive) {
          rsu.messagesHandled += 1;
          if (msg.type === "denm-hazard") seen.set(msg.id, { senderId: vehicle.id, msg });
          else if (msg.type === "cam")
            rsu.reportedOccupancy.set(String(msg.payload.segment_id), {
              occupancy: Number(msg.payload.occupancy),
              tick: this.tick,
              trust: this.trust.score(vehicle.id),
            });
        } else if (msg.type === "cam") {
          this.vehicles
            .get(nodeIdent)
            ?.receiveOccupancyPing(String(msg.payload.segment_id), Number(msg.payload.occupancy), this.tick);
        } else if (msg.type === "cpm") {
          // A peer's sensors saw a road user. The receiver now knows about
          // someone it may have no way of seeing itself.
          const peer = this.vehicles.get(nodeIdent);
          if (peer) {
            const segmentId = String(msg.payload.segment_id);
            const blind = !peer.knowsPedestrianOn(segmentId, this.tick);
            peer.receivePerceivedObject(segmentId, this.tick);
            if (blind && peer.pedestrianKnownOnlyFromPeers(segmentId, this.tick))
              this.perceptionStats.warnedBlind += 1;
          }
        } else if (msg.type === "mcm") {
          // A peer said where it is going. This is the only channel that makes
          // coordinated rerouting possible, and like every other belief it is
          // written only on delivery.
          const planned = String(msg.payload.segments ?? "");
          if (planned) this.vehicles.get(nodeIdent)?.receiveIntent(planned.split(","), this.tick);
        } else if (msg.type === "denm-eebl") {
          const peer = this.vehicles.get(nodeIdent);
          if (peer) {
            peer.receiveHazardWarning(String(msg.payload.segment_id), this.tick);
            this.perceptionStats.brakeWarnings += 1;
          }
        }
      }
    }

    if (!this.config.v2v_enabled) {
      const remaining: typeof this.cloudInbox = [];
      for (const entry of this.cloudInbox) {
        if (entry.due <= this.tick) {
          if (serviceUp && entry.msg.type === "denm-hazard")
            seen.set(entry.msg.id, { senderId: entry.senderId, msg: entry.msg });
        } else remaining.push(entry);
      }
      this.cloudInbox = remaining;
    }

    this.pendingReports = [...seen.values()];
  }

  private uploadTelemetry(vehicle: Vehicle, serviceUp: boolean) {
    const frame = makeMessage({
      type: "telemetry-upload",
      senderId: vehicle.id,
      pseudonym: vehicle.pseudonym,
      payload: {
        node: vehicle.node,
        segment_id: vehicle.currentSegmentId ?? "",
        speed: vehicle.speedKmh,
        progress: Math.round(vehicle.progress * 1000) / 1000,
        heading: vehicle.nextNode ?? "",
      },
      ttl: 1,
      createdTick: this.tick,
      signed: true,
    });
    const bytes = messageBytes(frame);
    this.metrics.recordUplink(bytes);
    this.bytesThisTick += bytes;
    this.messagesThisTick += 1;
    this.metrics.recordBroadcast(1, serviceUp ? 1 : 0, 0, MESSAGE_SPECS[frame.type].designator);
  }

  private admit(receiverId: string, msg: Message): boolean {
    if (msg.pseudonym && !this.authority.verify(msg.pseudonym, this.tick)) return false;
    return this.replayGuard.accept(receiverId, msg.id, msg.createdTick, this.tick);
  }

  private channelLoad(origin: string): number {
    let nearby = 0;
    for (const v of this.vehicles.values()) if (v.node === origin) nearby += 1;
    return Math.min(1, nearby / 6);
  }

  private recipientHandles(): RecipientHandle[] {
    const handles: RecipientHandle[] = [];
    for (const r of this.rsus.values()) handles.push({ nodeId: r.id, gridNode: r.node, isAlive: r.alive });
    for (const v of this.vehicles.values()) handles.push({ nodeId: v.id, gridNode: v.node, isAlive: true });
    return handles;
  }

  /** Which vehicles could have witnessed each segment this tick — so trust is
   *  only scored when corroboration was actually possible. */
  private witnessMap(): Map<string, Set<string>> {
    const witnesses = new Map<string, Set<string>>();
    const add = (segId: string, id: string) => {
      if (!witnesses.has(segId)) witnesses.set(segId, new Set());
      witnesses.get(segId)!.add(id);
    };
    for (const v of this.vehicles.values()) {
      const segId = v.currentSegmentId;
      if (!segId) continue;
      add(segId, v.id);
      const seg = this.grid.segments.get(segId);
      if (seg) for (const adj of this.grid.adjacentSegments(seg)) add(adj.id, v.id);
    }
    return witnesses;
  }

  private processReports(serviceUp: boolean) {
    if (this.pendingReports.length && serviceUp) {
      this.corroboration.process(
        this.pendingReports,
        this.trust,
        this.grid,
        this.tick,
        this.metrics,
        this.witnessMap(),
      );
      for (const segId of this.corroboration.newlyConfirmed) {
        this.alerts.raiseAlert(segId, this.tick, "corroborated hazard");
        this.log("incident_confirmed", `Incident corroborated on ${segId}; warning dispatched.`);
      }
      for (const { senderId } of this.pendingReports) {
        const v = this.vehicles.get(senderId);
        if (v) v.trustHint = this.trust.score(senderId);
        if (this.trust.shouldRevoke(senderId) && !this.authority.revoked.has(senderId)) {
          this.authority.revoke(senderId);
          this.log(
            "certificate_revoked",
            `${senderId} revoked: ${this.trust.seen.get(senderId) ?? 0} reports, trust ${this.trust
              .score(senderId)
              .toFixed(2)}.`,
          );
        }
      }
    }
    if (serviceUp) this.alerts.dispatch(this.tick, [...this.vehicles.values()], this.grid, this.metrics);
  }

  private runEdgeAndLearning() {
    const runInference = this.config.rsu_edge_ai && this.tick % this.inferenceInterval === 0;
    for (const rsu of this.rsus.values()) {
      if (!rsu.alive) continue;
      if (runInference)
        rsu.runPrediction(this.predictor, this.tick, this.config.federated_learning, this.explainPredictions);
      if (this.config.federated_learning)
        rsu.collectTrainingSamples(this.predictor, this.tick, this.cellTrust(rsu.id));
    }

    if (this.config.federated_learning && this.tick % FL_ROUND_INTERVAL_TICKS === 0) {
      const clients = [...this.rsus.values()].filter((r) => r.alive).map((r) => r.flClient);
      const summary = this.federation.runRound(clients, this.tick);
      if (summary) {
        this.metrics.recordUplink(Math.round(summary.weights_kilobytes * 1024));
        this.log(
          "fl_round",
          `FL round ${summary.round}: ${summary.client_count} RSUs, loss ${summary.global_loss.toFixed(
            4,
          )}, ${summary.raw_kilobytes_avoided.toFixed(1)} KB of raw telemetry never transmitted.`,
        );
      }
    }
  }

  private runInfrastructure(serviceUp: boolean) {
    for (const rsu of this.rsus.values())
      if (rsu.alive && this.cloudOnline && rsu.buildDigest(this.tick, this.rsuNetwork.vehicleCell))
        this.metrics.recordUplink(40);

    if (this.tick % FOG_INTERVAL_TICKS === 0)
      for (const fog of this.fogNodes.values()) {
        const wasAlert = fog.alert;
        fog.aggregate(this.rsus, this.rsuNetwork.vehicleCell);
        if (fog.alert && !wasAlert)
          this.log("fog_alert", `${fog.id} regional congestion alert across ${fog.memberRsuIds.join(", ")}.`);
        else if (wasAlert && !fog.alert) this.log("fog_recovered", `${fog.id} regional congestion cleared.`);
      }

    if (this.config.digital_twin_sync && this.cloudOnline && this.tick % TWIN_SYNC_INTERVAL_TICKS === 0) {
      const before = this.twin.bytesSynced;
      this.twin.sync(this.tick);
      this.metrics.recordUplink(this.twin.bytesSynced - before);
    }

    for (const v of this.vehicles.values())
      this.rsuNetwork.assignVehicle(this.grid, v.id, v.node, this.tick);
    for (const entry of this.rsuNetwork.handoverLog.slice(-5))
      if (entry.tick === this.tick)
        this.log("self_heal", `${entry.vehicle_id} handed over ${entry.from} → ${entry.to}.`);

    for (const light of this.trafficLights.values()) light.step(this.tick);

    const ambulances = [...this.vehicles.values()].filter((v) => v.kind === "ambulance");
    if (this.config.v2v_enabled) this.broadcastSpat();

    if (ambulances.length && this.config.emergency_corridor && serviceUp) {
      this.corridor.step(this.tick, ambulances, [...this.vehicles.values()], this.trafficLights);
      this.transmitCorridorFrames();
      this.exchangeSignalPriority();
    }
  }

  /** Transmit one frame and pay for it. Returns who decoded it. */
  private putOnAir(frame: Message, originNode: string, recipients: RecipientHandle[]): string[] {
    frame.certificateAttached = this.certPolicy.attach(frame.pseudonym || frame.senderId);
    const load = this.channelLoad(originNode);
    const { delivered, intended } = this.bus.broadcast(frame, originNode, this.tick, recipients, load);
    const bytes = messageBytes(frame);
    this.messagesThisTick += delivered.length;
    this.bytesThisTick += bytes;
    this.metrics.recordBroadcast(intended, delivered.length, bytes, MESSAGE_SPECS[frame.type].designator);
    this.recordTransmission(frame, originNode, delivered, intended);
    return delivered;
  }

  private recordTransmission(
    frame: Message,
    originNode: string,
    delivered: string[],
    intended: number,
  ) {
    this.transmissions.push({
      id: frame.id,
      tick: this.tick,
      designator: MESSAGE_SPECS[frame.type].designator,
      type: frame.type,
      sender_id: frame.senderId,
      origin_node: originNode,
      delivered_to: delivered,
      intended,
      segment_id: frame.payload.segment_id as string | undefined,
      hazard_type: frame.payload.hazard_type as string | undefined,
      cause_code: frame.payload.cause_code as number | undefined,
    });
    if (this.transmissions.length > TRANSMISSION_LOG_LIMIT) this.transmissions.shift();
  }

  /** Put the corridor's DENMs on the air and pay for them. These frames used
   *  to be built and dropped, so the corridor appeared to cost no bandwidth. */
  private transmitCorridorFrames() {
    const frames = this.corridor.drainFrames();
    if (!frames.length) return;
    const recipients = this.recipientHandles();
    for (const frame of frames) {
      const origin = this.vehicles.get(frame.senderId);
      if (!origin) continue;
      this.putOnAir(frame, origin.node, recipients);
    }
  }

  /**
   * Every signalised intersection announces its phase (TS 103 301).
   *
   * SPaT is never relayed — it describes one junction and is only useful to
   * vehicles approaching it — so it goes out at TTL 1.
   */
  private broadcastSpat() {
    if (this.tick % SPAT_BROADCAST_INTERVAL_TICKS !== 0) return;
    const recipients = this.recipientHandles();
    for (const light of this.trafficLights.values()) {
      const rsuId = this.rsuAt.get(light.node);
      // The roadside radio is what transmits it. No radio, no SPaT.
      if (!rsuId || !this.rsus.get(rsuId)?.alive) continue;
      const delivered = this.putOnAir(
        makeMessage({
          type: "spatem",
          senderId: light.id,
          pseudonym: "",
          payload: { intersection: light.node, phase: light.phase },
          ttl: 1,
          createdTick: this.tick,
          signed: false,
        }),
        light.node,
        recipients,
      );
      // Transmitting is not delivering: hand the phase to every vehicle that
      // actually decoded the frame, or GLOSA has nothing to act on.
      for (const receiver of delivered)
        this.vehicles.get(receiver)?.receiveSignalPhase(light.node, light.phase, this.tick);
    }
  }

  /**
   * SREM out, SSEM back (TS 103 301).
   *
   * A direct method call always lands. A radio message does not: this one can
   * be lost on the air, and the intersection can refuse it. Both are things a
   * real deployment copes with and a function call hides.
   */
  private exchangeSignalPriority() {
    const requests = this.corridor.drainRequests();
    if (!requests.length) return;
    const recipients = this.recipientHandles();

    for (const req of requests) {
      const ambulance = this.vehicles.get(req.ambulanceId);
      const light = this.trafficLights.get(req.intersection);
      if (!ambulance || !light) continue;

      this.signalRequests.requested += 1;
      const delivered = this.putOnAir(
        makeMessage({
          type: "srem",
          senderId: ambulance.id,
          pseudonym: ambulance.pseudonym,
          payload: {
            request_id: req.requestId,
            intersection: req.intersection,
            eta_seconds: req.etaSeconds,
          },
          ttl: SIGNAL_REQUEST_TTL_HOPS,
          createdTick: this.tick,
          signed: true,
        }),
        ambulance.node,
        recipients,
      );

      const rsuId = this.rsuAt.get(req.intersection);
      const heard = !!rsuId && delivered.includes(rsuId) && !!this.rsus.get(rsuId)?.alive;
      if (!heard) {
        // Out of range, the frame collided, or the roadside unit is down.
        // The light simply never learns it was asked.
        this.signalRequests.unheard += 1;
        continue;
      }

      light.preempt(this.tick, req.holdTicks, `${ambulance.id} ETA ${req.etaSeconds}s`);
      this.signalRequests.granted += 1;
      this.putOnAir(
        makeMessage({
          type: "ssem",
          senderId: light.id,
          pseudonym: "",
          payload: {
            request_id: req.requestId,
            intersection: req.intersection,
            status: SIGNAL_REQUEST_STATUS.GRANTED,
          },
          ttl: SIGNAL_REQUEST_TTL_HOPS,
          createdTick: this.tick,
          signed: false,
        }),
        light.node,
        recipients,
      );
    }
  }

  /**
   * Mean trust of the vehicles currently homed to this RSU.
   *
   * This is the link between M11 and M7: an RSU whose cell is full of vehicles
   * the network has stopped believing is an RSU whose training data should not
   * be averaged in at full weight.
   */
  private cellTrust(rsuId: string): number {
    const scores: number[] = [];
    for (const [vid, cell] of this.rsuNetwork.vehicleCell)
      if (cell === rsuId && this.vehicles.has(vid)) scores.push(this.trust.score(vid));
    if (!scores.length) return 1;
    return scores.reduce((a, b) => a + b, 0) / scores.length;
  }

  /**
   * Age pedestrians off the crossing, then work out who can see them.
   *
   * Line of sight is the whole mechanic. A vehicle travelling *along* the
   * segment being crossed has a clear view down the road. A vehicle about to
   * turn into that crossing from a perpendicular street does not — the corner
   * is in the way. That asymmetry is what makes collective perception worth
   * the bandwidth, and it is the turning case from the Porsche prototypes.
   */
  private pedestrianLifecycle() {
    for (const [pid, ped] of [...this.pedestrians]) {
      ped.step();
      if (!ped.active) this.pedestrians.delete(pid);
    }

    for (const vehicle of this.vehicles.values()) {
      vehicle.seenPedestrians = new Map(
        [...this.pedestrians.values()]
          .filter((ped) => this.hasLineOfSight(vehicle, ped))
          .map((ped) => [ped.segmentId, this.tick] as const),
      );
      // Anyone who can see a pedestrian in their own path brakes for them,
      // which is what generates the emergency brake warning.
      const here = vehicle.currentSegmentId;
      if (here && vehicle.seenPedestrians.has(here)) vehicle.brakeHard();
    }
  }

  /**
   * Can this vehicle physically see this pedestrian?
   *
   * Only from on the crossing segment itself. Approaching the same
   * intersection down a different street does not count — that vehicle is
   * turning blind.
   */
  hasLineOfSight(vehicle: Vehicle, ped: Pedestrian): boolean {
    return vehicle.currentSegmentId === ped.segmentId;
  }

  private hazardLifecycle() {
    if (this.autoHazards && this.rng.next() < HAZARD_SPAWN_PROBABILITY) this.injectHazard();
    for (const seg of this.grid.allSegments()) {
      const wasActive = seg.hazardActive;
      seg.tickDown();
      if (wasActive && !seg.hazardActive) this.metrics.hazardCleared(seg.id);
    }
    this.grid.decayOccupancy();
    this.replayGuard.prune(this.tick);
  }

  private log(type: string, message: string) {
    this.eventLog.push({ tick: this.tick, type, message });
    if (this.eventLog.length > MAX_EVENTS) this.eventLog.shift();
  }

  stateSnapshot(): SimulationState {
    const cellCounts = new Map<string, number>();
    for (const rsuId of this.rsuNetwork.vehicleCell.values())
      cellCounts.set(rsuId, (cellCounts.get(rsuId) ?? 0) + 1);

    return {
      tick: this.tick,
      grid_size: this.grid.size,
      config: this.config,
      cloud_online: this.cloudOnline,
      messages_this_tick: this.messagesThisTick,
      kilobytes_this_tick: Math.round((this.bytesThisTick / 1024) * 100) / 100,
      reroutes_this_tick: this.reroutesThisTick,
      total_reroutes: [...this.vehicles.values()].reduce((s, v) => s + v.rerouteCount, 0),
      frames_rejected: this.blockedThisTick,
      segments: this.grid.allSegments().map((s) => ({
        id: s.id,
        a: s.a,
        b: s.b,
        occupancy: Math.round(s.occupancy * 1000) / 1000,
        hazard_active: s.hazardActive,
        hazard_type: s.hazardType,
        confirmed_incident: s.confirmedIncident,
      })),
      vehicles: [...this.vehicles.values()].map((v) => v.toState()),
      rsus: [...this.rsus.values()].map((r) => r.toState(cellCounts.get(r.id) ?? 0)),
      fog_nodes: [...this.fogNodes.values()].map((f) => f.toState()),
      traffic_lights: [...this.trafficLights.values()].map((t) => t.toState()),
      trust: this.trust.snapshot(),
      security: {
        pseudonyms: this.authority.snapshot(this.vehicles.size),
        replay: this.replayGuard.snapshot(),
        certificates: this.certPolicy.snapshot(),
      },
      federated: this.federation.snapshot(),
      digital_twin: this.twin.snapshot(this.tick),
      alerts: this.alerts.snapshot(),
      metrics: this.metrics.summary(),
      active_corridors: [...this.corridor.activeCorridors],
      pedestrians: [...this.pedestrians.values()].map((ped) => ({
        id: ped.id,
        node: ped.node,
        segment_id: ped.segmentId,
        ticks_remaining: ped.ticksRemaining,
        // Who can physically see them, versus who only knows because a peer
        // told them. The gap between these two lists is the value collective
        // perception adds, made visible.
        seen_by: [...this.vehicles.values()].filter((v) => this.hasLineOfSight(v, ped)).map((v) => v.id).sort(),
        known_by: [...this.vehicles.values()]
          .filter((v) => v.pedestrianKnownOnlyFromPeers(ped.segmentId, this.tick))
          .map((v) => v.id)
          .sort(),
      })),
      collisions: [...this.collisions],
      perception: {
        shared: this.perceptionStats.shared,
        warned_blind: this.perceptionStats.warnedBlind,
        brake_warnings: this.perceptionStats.brakeWarnings,
        glosa_active: [...this.vehicles.values()].filter((v) => v.glosaAdvice !== null).length,
      },
      signal_priority: {
        ...this.signalRequests,
        grant_rate_pct:
          Math.round((1000 * this.signalRequests.granted) / Math.max(this.signalRequests.requested, 1)) / 10,
      },
      handovers: this.rsuNetwork.handoverLog.slice(-20),
      transmissions: [...this.transmissions],
      events: [...this.eventLog].slice(-40).reverse(),
    } as SimulationState;
  }
}

export { INCIDENT_DURATION_TICKS };
