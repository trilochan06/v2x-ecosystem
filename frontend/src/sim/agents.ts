/** Vehicles (M1/M3/M6), RSUs (M4/M5/M7), and the infrastructure tiers:
 *  fog (regional), traffic lights, digital twin (M8), alerts (M9) and
 *  emergency corridors (M10). Ported from `backend/app/simulation/`. */
import { CongestionPredictor, FederatedClient, PREDICTION_HORIZON_TICKS } from "./ai";
import type { PredictionResult } from "./ai";
import { CityGrid, HAZARD_TYPES, Message, Rng, Segment, makeMessage } from "./core";

// ----------------------------------------------------------- vehicle
export type VehicleKind = "car" | "ambulance" | "malicious";

const OCCUPANCY_PING_INTERVAL_TICKS = 4;
const OCCUPANCY_PING_TTL_HOPS = 2;
const PEER_INFO_STALE_TICKS = 15;
const CONGESTION_REROUTE_THRESHOLD = 0.8;
const REROUTE_COOLDOWN_TICKS = 25;
const REROUTE_LOOKAHEAD_HOPS = 3;
const HAZARD_SENSE_PROBABILITY = 0.6;
const LOOKAHEAD_SENSE_PROBABILITY = 0.3;
const SENSOR_NOISE_PROBABILITY = 0.004;
const FABRICATION_PROBABILITY = 0.35;

export class Vehicle {
  destination = "";
  route: string[] = [];
  progress = 0;
  pseudonym = "";
  yieldInstruction: { eta_seconds: number; explanation: string } | null = null;
  trustHint = 1;
  rerouteCount = 0;
  tripStartedTick = 0;
  /** Peer-shared knowledge only — written solely by receiveOccupancyPing, so
   *  rerouting is a genuine decentralized decision rather than a read of
   *  global state. */
  knownOccupancy = new Map<string, { occupancy: number; tick: number }>();
  hazardWarnings = new Map<string, number>();
  private rerouteCooldownUntil = 0;

  constructor(
    readonly id: string,
    readonly kind: VehicleKind,
    private grid: CityGrid,
    public node: string,
    readonly speedKmh: number,
    private rng: Rng,
    tick = 0,
  ) {
    this.pickNewDestination(tick);
  }

  private pickNewDestination(tick: number) {
    const candidates = [...this.grid.nodes.keys()].filter((n) => n !== this.node);
    this.destination = this.rng.pick(candidates);
    this.route = this.grid.shortestPath(this.node, this.destination);
    this.progress = 0;
    this.tripStartedTick = tick;
  }

  get nextNode(): string | null {
    return this.route.length >= 2 ? this.route[1] : null;
  }

  get currentSegmentId(): string | null {
    const nxt = this.nextNode;
    return nxt ? this.grid.segmentBetween(this.node, nxt).id : null;
  }

  positionXY(): [number, number] {
    const [ax, ay] = this.grid.coords(this.node);
    const nxt = this.nextNode;
    if (!nxt) return [ax, ay];
    const [bx, by] = this.grid.coords(nxt);
    return [ax + (bx - ax) * this.progress, ay + (by - ay) * this.progress];
  }

  step(tick: number, allowV2v: boolean, allowRerouting: boolean) {
    const outbound: Message[] = [];
    let rerouted = false;
    let completedTrip: number | null = null;

    const nxt = this.nextNode;
    if (!nxt) return { outbound, rerouted, completedTrip };

    const seg = this.grid.segmentBetween(this.node, nxt);
    seg.occupancy = Math.min(1, seg.occupancy + (this.kind === "ambulance" ? 0.02 : 0.05));

    // Greenshields-style speed/density relation: without it, sitting in a jam
    // is free and any detour is pure loss.
    let speed = this.speedKmh * Math.max(0.25, 1 - 0.75 * seg.occupancy);
    if (this.yieldInstruction) speed *= 0.35;
    if (seg.hazardActive) speed *= 0.4;
    if (this.recentWarning(seg.id, tick)) speed *= 0.85;

    this.progress += ((speed * 1000) / 3600) / seg.lengthM;
    if (this.progress >= 1) {
      this.node = nxt;
      this.progress = 0;
      this.route.shift();
      if (this.route.length <= 1) {
        completedTrip = tick - this.tripStartedTick;
        this.pickNewDestination(tick);
      }
    }

    const hazard = this.maybeReportHazard(seg, this.lookaheadSegment(), tick);
    if (hazard) outbound.push(hazard);

    if (allowV2v) {
      const ping = this.maybeShareOccupancy(seg, tick);
      if (ping) outbound.push(ping);
      if (allowRerouting) rerouted = this.maybeReroute(tick);
    }

    return { outbound, rerouted, completedTrip };
  }

  private lookaheadSegment(): Segment | null {
    if (this.route.length < 3) return null;
    return this.grid.segmentBetween(this.route[1], this.route[2]);
  }

  private maybeReportHazard(seg: Segment, ahead: Segment | null, tick: number): Message | null {
    if (this.kind === "malicious") {
      if (!seg.hazardActive && this.rng.next() < FABRICATION_PROBABILITY)
        return this.hazardMessage(seg, this.rng.pick(HAZARD_TYPES), 0.9, tick);
      return null;
    }
    if (seg.hazardActive && this.rng.next() < HAZARD_SENSE_PROBABILITY)
      return this.hazardMessage(seg, seg.hazardType || "accident", 0.85, tick);
    if (ahead?.hazardActive && this.rng.next() < LOOKAHEAD_SENSE_PROBABILITY)
      return this.hazardMessage(ahead, ahead.hazardType || "accident", 0.7, tick);
    if (this.rng.next() < SENSOR_NOISE_PROBABILITY)
      return this.hazardMessage(seg, this.rng.pick(HAZARD_TYPES), 0.5, tick);
    return null;
  }

  private hazardMessage(seg: Segment, hazardType: string, confidence: number, tick: number) {
    return makeMessage({
      type: "hazard_report",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: { segment_id: seg.id, hazard_type: hazardType, confidence },
      ttl: 3,
      createdTick: tick,
      signed: true,
    });
  }

  private maybeShareOccupancy(seg: Segment, tick: number): Message | null {
    if (tick % OCCUPANCY_PING_INTERVAL_TICKS !== 0) return null;
    return makeMessage({
      type: "occupancy_ping",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: { segment_id: seg.id, occupancy: Math.round(seg.occupancy * 1000) / 1000 },
      ttl: OCCUPANCY_PING_TTL_HOPS,
      createdTick: tick,
      signed: true,
    });
  }

  receiveOccupancyPing(segmentId: string, occupancy: number, tick: number) {
    this.knownOccupancy.set(segmentId, { occupancy, tick });
  }

  receiveHazardWarning(segmentId: string, tick: number) {
    this.hazardWarnings.set(segmentId, tick);
  }

  private recentWarning(segmentId: string, tick: number) {
    const heard = this.hazardWarnings.get(segmentId);
    return heard !== undefined && tick - heard <= PEER_INFO_STALE_TICKS;
  }

  private maybeReroute(tick: number): boolean {
    if (this.kind === "ambulance") return false;
    if (tick < this.rerouteCooldownUntil || this.route.length < 3) return false;

    const upcoming = this.route.slice(1, REROUTE_LOOKAHEAD_HOPS + 2);
    const avoid = new Set<string>();
    for (let i = 0; i < upcoming.length - 1; i++) {
      const seg = this.grid.segmentBetween(upcoming[i], upcoming[i + 1]);
      if (this.recentWarning(seg.id, tick)) {
        avoid.add(seg.id);
        continue;
      }
      const info = this.knownOccupancy.get(seg.id);
      if (!info || tick - info.tick > PEER_INFO_STALE_TICKS) continue;
      if (info.occupancy >= CONGESTION_REROUTE_THRESHOLD) avoid.add(seg.id);
    }
    if (!avoid.size) return false;

    const newRoute = this.grid.shortestPathAvoiding(this.node, this.destination, avoid);
    if (newRoute.length && newRoute.join() !== this.route.join()) {
      this.route = newRoute;
      this.rerouteCooldownUntil = tick + REROUTE_COOLDOWN_TICKS;
      this.rerouteCount += 1;
      return true;
    }
    return false;
  }

  toState() {
    const [x, y] = this.positionXY();
    return {
      id: this.id,
      pseudonym: this.pseudonym,
      kind: this.kind,
      x,
      y,
      node: this.node,
      next_node: this.nextNode,
      destination: this.destination,
      segment_id: this.currentSegmentId,
      yielding: Boolean(this.yieldInstruction),
      trust_hint: this.trustHint,
      reroute_count: this.rerouteCount,
    };
  }
}

// --------------------------------------------------------------- RSU
const DIGEST_INTERVAL_TICKS = 10;
const PENDING_SAMPLE_LIMIT = 600;

export class RSU {
  alive = true;
  predictions = new Map<string, PredictionResult>();
  flClient: FederatedClient;
  messagesHandled = 0;
  private pending: { due: number; segId: string; feats: number[] }[] = [];

  constructor(
    readonly id: string,
    readonly node: string,
    private grid: CityGrid,
  ) {
    this.flClient = new FederatedClient(id);
  }

  localSegments(): Segment[] {
    return this.grid.neighbors(this.node).map((n) => this.grid.segmentBetween(this.node, n));
  }

  neighborAvgFor(seg: Segment): number {
    const nbs = this.grid.adjacentSegments(seg);
    return nbs.length ? nbs.reduce((s, n) => s + n.occupancy, 0) / nbs.length : seg.occupancy;
  }

  runPrediction(predictor: CongestionPredictor, tick: number, useFederated: boolean, explain = true) {
    for (const seg of this.localSegments()) {
      const neighborAvg = this.neighborAvgFor(seg);
      const result = predictor.predict(seg, tick, neighborAvg, explain);
      if (useFederated && this.flClient.roundsJoined > 0) {
        const feats = predictor.buildFeatures(seg, tick, neighborAvg);
        this.predictions.set(seg.id, {
          ...result,
          predicted_occupancy: Math.round(this.flClient.predictOne(feats) * 1000) / 1000,
          model: "federated",
          centralized_reference: result.predicted_occupancy,
        });
      } else {
        this.predictions.set(seg.id, { ...result, model: "centralized" });
      }
    }
  }

  /** Park this tick's features; harvest the ones whose horizon elapsed. No
   *  labels from the future. */
  collectTrainingSamples(predictor: CongestionPredictor, tick: number) {
    for (const seg of this.localSegments())
      this.pending.push({
        due: tick + PREDICTION_HORIZON_TICKS,
        segId: seg.id,
        feats: predictor.buildFeatures(seg, tick, this.neighborAvgFor(seg)),
      });
    while (this.pending.length > PENDING_SAMPLE_LIMIT) this.pending.shift();

    while (this.pending.length && this.pending[0].due <= tick) {
      const { segId, feats } = this.pending.shift()!;
      const seg = this.grid.segments.get(segId);
      if (seg) this.flClient.observe(feats, seg.occupancy);
    }
  }

  buildDigest(tick: number, vehicleCell: Map<string, string>) {
    if (tick % DIGEST_INTERVAL_TICKS !== 0) return null;
    const segs = this.localSegments();
    if (!segs.length) return null;
    return {
      tick,
      rsu_id: this.id,
      segment_count: segs.length,
      avg_occupancy: Math.round((segs.reduce((s, x) => s + x.occupancy, 0) / segs.length) * 1000) / 1000,
      incident_count: segs.filter((s) => s.confirmedIncident).length,
      vehicles_served: [...vehicleCell.values()].filter((r) => r === this.id).length,
    };
  }

  toState(cellSize: number) {
    return {
      id: this.id,
      node: this.node,
      alive: this.alive,
      predictions: Object.fromEntries(this.predictions),
      cell_size: cellSize,
      messages_handled: this.messagesHandled,
      fl: {
        pending_samples: this.flClient.pendingSamples,
        rounds_joined: this.flClient.roundsJoined,
        samples_contributed: this.flClient.samplesContributed,
        drift: Math.round(this.flClient.lastDrift * 10000) / 10000,
      },
    };
  }
}

// ---------------------------------------------- RSU topology (self-heal)
export class RSUNetwork {
  positions = new Map<string, string>();
  alive = new Map<string, boolean>();
  vehicleCell = new Map<string, string>();
  handoverLog: { tick: number; vehicle_id: string; from: string; to: string; reason: string }[] = [];

  register(rsuId: string, node: string) {
    this.positions.set(rsuId, node);
    this.alive.set(rsuId, true);
  }

  setAlive(rsuId: string, alive: boolean) {
    this.alive.set(rsuId, alive);
  }

  nearestAlive(grid: CityGrid, from: string): string | null {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const [id, node] of this.positions) {
      if (!this.alive.get(id)) continue;
      const d = grid.euclidean(from, node);
      if (d < bestDist) {
        best = id;
        bestDist = d;
      }
    }
    return best;
  }

  assignVehicle(grid: CityGrid, vehicleId: string, from: string, tick: number) {
    const current = this.vehicleCell.get(vehicleId);
    if (current && this.alive.get(current)) return current;
    const next = this.nearestAlive(grid, from);
    if (next && next !== current) {
      this.vehicleCell.set(vehicleId, next);
      if (current) {
        this.handoverLog.push({ tick, vehicle_id: vehicleId, from: current, to: next, reason: "self_heal" });
        if (this.handoverLog.length > 200) this.handoverLog.shift();
      }
    }
    return this.vehicleCell.get(vehicleId) ?? null;
  }
}

// ---------------------------------------------------------- fog tier
const REGIONAL_ALERT_THRESHOLD = 0.6;

export class FogNode {
  alert = false;
  private latest: { avg: number; incidents: number; served: number } | null = null;

  constructor(
    readonly id: string,
    readonly memberRsuIds: string[],
    readonly x: number,
    readonly y: number,
  ) {}

  aggregate(rsus: Map<string, RSU>, vehicleCell: Map<string, string>) {
    const members = this.memberRsuIds.map((r) => rsus.get(r)).filter((r): r is RSU => Boolean(r?.alive));
    if (!members.length) {
      this.alert = false;
      return null;
    }
    const segs = members.flatMap((r) => r.localSegments());
    const avg = segs.length ? segs.reduce((s, x) => s + x.occupancy, 0) / segs.length : 0;
    this.alert = avg >= REGIONAL_ALERT_THRESHOLD;
    this.latest = {
      avg: Math.round(avg * 1000) / 1000,
      incidents: segs.filter((s) => s.confirmedIncident).length,
      served: [...vehicleCell.values()].filter((r) => this.memberRsuIds.includes(r)).length,
    };
    return this.latest;
  }

  toState() {
    return {
      id: this.id,
      x: this.x,
      y: this.y,
      member_rsu_ids: this.memberRsuIds,
      alert: this.alert,
      avg_occupancy: this.latest?.avg ?? 0,
      incident_count: this.latest?.incidents ?? 0,
      vehicles_served: this.latest?.served ?? 0,
    };
  }
}

export function buildFogClusters(
  rsuIds: string[],
  coords: Map<string, [number, number]>,
  clusterSize = 3,
): FogNode[] {
  // Sorting by (x, y) before chunking keeps each cluster a contiguous district.
  const ordered = [...rsuIds].sort((a, b) => {
    const [ax, ay] = coords.get(a)!;
    const [bx, by] = coords.get(b)!;
    return ax - bx || ay - by;
  });
  const nodes: FogNode[] = [];
  for (let i = 0; i < ordered.length; i += clusterSize) {
    const chunk = ordered.slice(i, i + clusterSize);
    if (!chunk.length) continue;
    const xs = chunk.map((r) => coords.get(r)![0]);
    const ys = chunk.map((r) => coords.get(r)![1]);
    nodes.push(
      new FogNode(
        `fog-${nodes.length + 1}`,
        chunk,
        xs.reduce((a, b) => a + b, 0) / xs.length,
        ys.reduce((a, b) => a + b, 0) / ys.length,
      ),
    );
  }
  return nodes;
}

// ------------------------------------------------------ traffic lights
const CYCLE_TICKS = 12;

export class TrafficLight {
  phase: "green" | "red" = "green";
  private preemptedUntil = -1;
  private preemptReason = "";

  constructor(
    readonly id: string,
    readonly node: string,
  ) {}

  step(tick: number) {
    if (tick <= this.preemptedUntil) {
      this.phase = "green";
      return;
    }
    this.preemptReason = "";
    this.phase = Math.floor(tick / CYCLE_TICKS) % 2 === 0 ? "green" : "red";
  }

  preempt(tick: number, holdTicks: number, reason: string) {
    this.preemptedUntil = Math.max(this.preemptedUntil, tick + holdTicks);
    this.preemptReason = reason;
  }

  toState() {
    return {
      id: this.id,
      node: this.node,
      phase: this.phase,
      preempted: this.preemptReason !== "",
      preempt_reason: this.preemptReason,
    };
  }
}

// --------------------------------------------------------- digital twin
export class DigitalTwin {
  private state = new Map<string, { occupancy: number; confirmed: boolean; lastSync: number }>();
  syncCount = 0;
  lastSyncTick = -1;
  bytesSynced = 0;

  constructor(private grid: CityGrid) {
    for (const seg of grid.allSegments())
      this.state.set(seg.id, { occupancy: 0, confirmed: false, lastSync: -1 });
  }

  sync(tick: number) {
    for (const seg of this.grid.allSegments())
      this.state.set(seg.id, {
        occupancy: seg.occupancy,
        confirmed: seg.confirmedIncident,
        lastSync: tick,
      });
    this.syncCount += 1;
    this.lastSyncTick = tick;
    this.bytesSynced += 12 * this.state.size;
  }

  /** Mean absolute error between the replica and physical reality. */
  divergence(): number {
    if (!this.state.size) return 0;
    let total = 0;
    for (const seg of this.grid.allSegments())
      total += Math.abs((this.state.get(seg.id)?.occupancy ?? 0) - seg.occupancy);
    return total / this.state.size;
  }

  snapshot(tick: number) {
    return {
      syncs: this.syncCount,
      last_sync_tick: this.lastSyncTick,
      staleness_ticks: this.lastSyncTick < 0 ? 0 : tick - this.lastSyncTick,
      divergence: Math.round(this.divergence() * 10000) / 10000,
      kilobytes_synced: Math.round((this.bytesSynced / 1024) * 100) / 100,
      congested_segments: [...this.state.values()].filter((s) => s.occupancy >= 0.7).length,
      tracked_segments: this.state.size,
    };
  }
}

// ------------------------------------------------------- M9 alerts
const ALERT_LOOKAHEAD_HOPS = 4;

export class AlertEngine {
  private queue: { segmentId: string; deliverAt: number; raisedTick: number; reason: string }[] = [];
  delivered: { tick: number; segment_id: string; reason: string; recipients: number; latency_ticks: number }[] = [];
  alertsRaised = 0;
  alertsDelivered = 0;

  constructor(public cloudRoundTripTicks = 0) {}

  raiseAlert(segmentId: string, tick: number, reason: string) {
    this.alertsRaised += 1;
    this.queue.push({
      segmentId,
      deliverAt: tick + this.cloudRoundTripTicks,
      raisedTick: tick,
      reason,
    });
  }

  dispatch(tick: number, vehicles: Vehicle[], grid: CityGrid, metrics?: { alertDelivered(s: string, t: number): void }) {
    const due = this.queue.filter((a) => a.deliverAt <= tick);
    if (!due.length) return [];
    this.queue = this.queue.filter((a) => a.deliverAt > tick);

    const notifications = [];
    for (const alert of due) {
      const recipients = vehicles.filter((v) => isRelevant(v, alert.segmentId, grid));
      for (const v of recipients) v.receiveHazardWarning(alert.segmentId, tick);
      if (recipients.length) {
        this.alertsDelivered += 1;
        metrics?.alertDelivered(alert.segmentId, tick);
      }
      notifications.push({
        tick,
        segment_id: alert.segmentId,
        reason: alert.reason,
        recipients: recipients.length,
        latency_ticks: tick - alert.raisedTick,
      });
    }
    this.delivered = [...this.delivered, ...notifications].slice(-40);
    return notifications;
  }

  snapshot() {
    return {
      alerts_raised: this.alertsRaised,
      alerts_delivered: this.alertsDelivered,
      queued: this.queue.length,
      cloud_round_trip_ticks: this.cloudRoundTripTicks,
      recent: [...this.delivered].reverse().slice(0, 12),
    };
  }
}

function isRelevant(vehicle: Vehicle, segmentId: string, grid: CityGrid): boolean {
  const upcoming = vehicle.route.slice(0, ALERT_LOOKAHEAD_HOPS + 1);
  for (let i = 0; i < upcoming.length - 1; i++)
    if (grid.segmentBetween(upcoming[i], upcoming[i + 1]).id === segmentId) return true;
  return false;
}

// ------------------------------------------------- M10 emergency corridor
const LOOKAHEAD_NODES = 4;
const PREEMPT_HOLD_TICKS = 8;

export class EmergencyCorridorManager {
  activeCorridors = new Set<string>();

  constructor(private grid: CityGrid) {}

  step(tick: number, ambulances: Vehicle[], allVehicles: Vehicle[], lights: Map<string, TrafficLight>) {
    const activeIds = new Set(ambulances.map((a) => a.id));
    for (const id of this.activeCorridors) if (!activeIds.has(id)) this.activeCorridors.delete(id);

    const corridorSegments = new Set<string>();
    for (const amb of ambulances) {
      this.activeCorridors.add(amb.id);
      const route = amb.route.slice(0, LOOKAHEAD_NODES);
      const eta = new Map<string, number>();
      let cumulative = 0;
      for (let i = 0; i < route.length - 1; i++) {
        const seg = this.grid.segmentBetween(route[i], route[i + 1]);
        cumulative += seg.lengthM;
        eta.set(route[i + 1], Math.round((cumulative / ((amb.speedKmh * 1000) / 3600)) * 10) / 10);
        corridorSegments.add(seg.id);
        lights.get(route[i + 1])?.preempt(tick, PREEMPT_HOLD_TICKS, `ambulance ${amb.id} ETA ${eta.get(route[i + 1])}s`);
      }

      for (const v of allVehicles) {
        if (v.kind === "ambulance") continue;
        if (v.currentSegmentId && corridorSegments.has(v.currentSegmentId)) {
          const seconds = eta.get(v.nextNode ?? "") ?? 0;
          v.yieldInstruction = {
            eta_seconds: seconds,
            explanation: `Ambulance ${amb.id} approaching, ETA ${seconds}s — yield lane and slow down.`,
          };
        }
      }
    }

    for (const v of allVehicles)
      if (v.kind !== "ambulance" && !(v.currentSegmentId && corridorSegments.has(v.currentSegmentId)))
        v.yieldInstruction = null;
  }
}
