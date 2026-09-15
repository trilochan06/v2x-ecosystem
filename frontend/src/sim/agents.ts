/** Vehicles (M1/M3/M6), RSUs (M4/M5/M7), and the infrastructure tiers:
 *  fog (regional), traffic lights, digital twin (M8), alerts (M9) and
 *  emergency corridors (M10). Ported from `backend/app/simulation/`. */
import { CongestionPredictor, FederatedClient, PREDICTION_HORIZON_TICKS } from "./ai";
import type { PredictionResult } from "./ai";
import {
  CAUSE_CODE,
  CityGrid,
  HAZARD_TYPES,
  Message,
  PATH_POINT_BYTES,
  PERCEIVED_OBJECT_BYTES,
  Rng,
  Segment,
  TRIP_PURPOSE,
  causeFor,
  makeMessage,
  weightedPick,
} from "./core";

// ----------------------------------------------------------- vehicle
export type VehicleKind = "car" | "ambulance" | "malicious";

const OCCUPANCY_PING_INTERVAL_TICKS = 4;
const OCCUPANCY_PING_TTL_HOPS = 2;
const PEER_INFO_STALE_TICKS = 15;
const CONGESTION_REROUTE_THRESHOLD = 0.8;
const REROUTE_COOLDOWN_TICKS = 25;
/** How long a vehicle keeps believing a pedestrian report it can no longer
 *  confirm itself. */
const PEDESTRIAN_MEMORY_TICKS = 8;
/** A hard-braking manoeuvre lasts this long and is broadcast throughout. */
const BRAKING_TICKS = 3;
const BRAKING_SPEED_FACTOR = 0.2;
const PEDESTRIAN_CAUTION_FACTOR = 0.45;
/** Closer than this to the junction, holding a speed for the green is worth
 *  advising. */
const GLOSA_APPROACH_PROGRESS = 0.35;
/** How long recovery takes to reach a wreck and lift it off the carriageway.
 *  Until then the wreck is immobile, blocking its lane and broadcasting; after
 *  it, the wreck leaves the city on a truck. It does not drive away. */
const RECOVERY_TICKS = 22;
/** A wrecked vehicle re-announces itself on this duty cycle. Every tick would
 *  be both unrealistic and a denial of service on its own neighbours. */
const CRASH_REPORT_INTERVAL_TICKS = 3;
/** What a wreck does to the lane it is sitting in. */
const CRASH_LANE_BLOCKAGE = 0.25;
const REROUTE_LOOKAHEAD_HOPS = 3;

// --- M6b: intent coordination
/** How often a vehicle announces where it is planning to go. */
const INTENT_BROADCAST_INTERVAL_TICKS = 5;
/** How far ahead it commits to. Announcing the whole route would be both a
 *  privacy giveaway and stale by the time it mattered. */
const INTENT_HORIZON_HOPS = 4;
/** A claim older than this is no longer evidence of anyone's plan. */
const INTENT_STALE_TICKS = 12;
/** How much one peer's claim inflates a road's cost. */
const INTENT_CLAIM_WEIGHT = 0.6;
/** A warned-about road is priced as very expensive rather than banned, so it
 *  stays available when every alternative is worse. */
const AVOID_SEGMENT_PENALTY = 12;
/**
 * Per-vehicle route jitter, and the reason this mechanism works at all.
 *
 * Every road here is the same length, so the shortest-path search is really
 * minimising hop count and ties are everywhere. Break those ties the same way
 * in every vehicle — which both a breadth-first search and a plain Dijkstra do
 * — and two cars in the same place heading the same way compute the
 * byte-identical detour. That is the herding effect at its source: not bad
 * pricing, just determinism.
 */
const ROUTE_JITTER = 0.25;
/**
 * How long a vehicle stays put once it arrives.
 *
 * A trip that ends by instantly starting another one is a random walk wearing
 * a destination. A short stop makes arrivals visible, and means the number of
 * vehicles actually moving varies over the day rather than being constant by
 * construction.
 */
const DWELL_TICKS = [4, 12] as const;
/**
 * How long a vehicle stands by a decision to avoid a road.
 *
 * Without this, a vehicle diverts off a congested road, hears one report about
 * the road it diverted onto, and swings straight back — and because the two
 * roads keep reporting on each other it oscillates for as long as the trip
 * lasts. Real navigation commits for a while; so does this.
 */
const AVOID_COMMIT_TICKS = 40;
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
  // --- Porsche prototype 1: emergency electronic brake light
  brakingTicks = 0;
  // --- Porsche prototype 2: collective perception
  /** Pedestrians this vehicle can physically see. segmentId -> tick. */
  seenPedestrians = new Map<string, number>();
  /** Pedestrians it only knows about because a peer shared them in a CPM. */
  toldPedestrians = new Map<string, number>();
  // --- Porsche prototype 3: GLOSA
  knownSignals = new Map<string, { phase: string; tick: number }>();
  glosaAdvice: number | null = null;
  // --- collision
  /** Once true, always true. A vehicle that has been in a collision is a
   *  wreck: it does not drive again, and it leaves the city on a truck. */
  crashed = false;
  crashedAtTick = -1;
  /** Ticks until recovery lifts the wreck out of the carriageway. Reaching
   *  zero is the engine's cue to remove it, not the vehicle's cue to move. */
  recoveryTicks = 0;
  // --- M6b: intent coordination
  /** What peers have announced they intend to drive. Written only by
   *  `receiveIntent`, so like every other peer belief it exists because a
   *  frame was actually delivered. */
  peerIntent = new Map<string, { claims: number; tick: number }>();
  /** Set by the engine from the architecture config. */
  intentCoordination = false;
  tripStartedTick = 0;
  /** Peer-shared knowledge only — written solely by receiveOccupancyPing, so
   *  rerouting is a genuine decentralized decision rather than a read of
   *  global state. */
  knownOccupancy = new Map<string, { occupancy: number; tick: number }>();
  hazardWarnings = new Map<string, number>();
  /** Why this vehicle is driving where it is driving, in words. */
  tripPurpose = "";
  /** Ticks left parked at the end of a trip. */
  dwellTicks = 0;
  /** Roads this vehicle decided to avoid, and until when. Kept so a diversion
   *  is a decision that holds rather than one it reverses next tick. */
  private avoiding = new Map<string, number>();
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

  /**
   * Choose somewhere to go, and a reason for going there.
   *
   * Destinations are drawn in proportion to what a place is for, not
   * uniformly: the centre pulls hardest, the estate next, and housing least.
   * That is what makes the evening jam form in the middle of the map on its
   * own, rather than only when the hazard injector puts it there.
   */
  private pickNewDestination(tick: number) {
    const candidates = [...this.grid.nodes.keys()].filter((n) => n !== this.node);
    this.destination =
      this.kind === "ambulance"
        ? this.rng.pick(candidates)
        : weightedPick(candidates, (n) => this.grid.attraction(n), this.rng);
    this.tripPurpose = TRIP_PURPOSE[this.grid.landUse(this.destination)];
    this.route = this.grid.shortestPath(this.node, this.destination);
    this.progress = 0;
    this.tripStartedTick = tick;
    this.avoiding.clear();
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

    // Parked at the end of a trip. The ignition is off, so nothing goes on
    // the air — a stationary car filling the channel with CAMs would be both
    // wrong and the loudest thing on the map.
    if (this.dwellTicks > 0) {
      this.dwellTicks -= 1;
      if (this.dwellTicks === 0) this.pickNewDestination(tick);
      return { outbound, rerouted, completedTrip };
    }

    const nxt = this.nextNode;
    if (!nxt) return { outbound, rerouted, completedTrip };

    const seg = this.grid.segmentBetween(this.node, nxt);
    seg.occupancy = Math.min(1, seg.occupancy + (this.kind === "ambulance" ? 0.02 : 0.05));

    // A wreck does not drive. It sits in the lane, blocks it, and keeps
    // announcing itself until recovery lifts it out — which is what gives the
    // traffic behind time to be warned and rerouted.
    if (this.crashed) {
      this.recoveryTicks = Math.max(0, this.recoveryTicks - 1);
      seg.occupancy = Math.min(1, seg.occupancy + CRASH_LANE_BLOCKAGE);
      this.glosaAdvice = null;
      // A wreck is stationary, not deaf and blind. It already announces the
      // accident, so refusing to share the pedestrian standing in front of it
      // would be an odd place to draw the line — and it silently starved
      // collective perception on exactly the road where it matters most.
      for (const message of [this.reportCrash(seg, tick), this.maybeSharePerception(tick)])
        if (message) outbound.push(message);
      return { outbound, rerouted, completedTrip };
    }

    // Greenshields-style speed/density relation: without it, sitting in a jam
    // is free and any detour is pure loss.
    let speed = this.speedKmh * Math.max(0.25, 1 - 0.75 * seg.occupancy);
    if (this.yieldInstruction) speed *= 0.35;
    if (seg.hazardActive) speed *= 0.4;
    if (this.recentWarning(seg.id, tick)) speed *= 0.85;

    // A pedestrian on the carriageway ahead. Whether this vehicle can see them
    // or was only told by a peer, it slows — that equivalence is the point of
    // collective perception.
    if (this.knowsPedestrianOn(seg.id, tick)) speed *= PEDESTRIAN_CAUTION_FACTOR;

    // Hard braking dominates everything else while it lasts.
    if (this.brakingTicks > 0) {
      this.brakingTicks -= 1;
      speed *= BRAKING_SPEED_FACTOR;
    }

    // GLOSA: hold a speed that arrives on green rather than racing up to a red
    // and accelerating away from it.
    this.glosaAdvice = this.glosaAdviceFor(nxt, tick, speed);
    if (this.glosaAdvice !== null) speed = Math.min(speed, this.glosaAdvice);

    this.progress += ((speed * 1000) / 3600) / seg.lengthM;
    if (this.progress >= 1) {
      this.node = nxt;
      this.progress = 0;
      this.route.shift();
      if (this.route.length <= 1) {
        completedTrip = tick - this.tripStartedTick;
        // Arrived. Park for a few ticks before setting off again, so a trip
        // ends somewhere instead of bouncing straight off its destination.
        this.dwellTicks = this.rng.int(DWELL_TICKS[0], DWELL_TICKS[1]);
        this.route = [this.node];
      }
    }

    const hazard = this.maybeReportHazard(seg, this.lookaheadSegment(), tick);
    if (hazard) outbound.push(hazard);

    if (allowV2v) {
      const eebl = this.maybeReportBraking(seg, tick);
      if (eebl) outbound.push(eebl);

      const cpm = this.maybeSharePerception(tick);
      if (cpm) outbound.push(cpm);

      const ping = this.maybeShareOccupancy(seg, tick);
      if (ping) outbound.push(ping);

      if (this.intentCoordination) {
        const intent = this.maybeShareIntent(tick);
        if (intent) outbound.push(intent);
      }

      if (allowRerouting) rerouted = this.reroute(tick);
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
    // A DENM identifies what it saw with a CauseCode/SubCauseCode from the
    // TS 102 894-2 dictionary, not a free-text label.
    const [causeCode, subCauseCode] = causeFor(hazardType);
    return makeMessage({
      type: "denm-hazard",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: {
        segment_id: seg.id,
        hazard_type: hazardType,
        cause_code: causeCode,
        sub_cause_code: subCauseCode,
        confidence,
      },
      ttl: 3,
      createdTick: tick,
      signed: true,
    });
  }

  // --------------------------------------------- M6b intent coordination
  /** The next few roads this vehicle is planning to drive. */
  intendedSegments(): string[] {
    const out: string[] = [];
    const horizon = this.route.slice(0, INTENT_HORIZON_HOPS + 1);
    for (let i = 0; i < horizon.length - 1; i++)
      out.push(this.grid.segmentBetween(horizon[i], horizon[i + 1]).id);
    return out;
  }

  /** MCM: announce the plan, so peers can avoid all picking it.
   *
   *  This is the message that makes coordination possible without any central
   *  assignment: nobody is told where to go, only where everyone else is
   *  already going. */
  maybeShareIntent(tick: number): Message | null {
    if (tick % INTENT_BROADCAST_INTERVAL_TICKS !== 0 || this.kind === "malicious") return null;
    const planned = this.intendedSegments();
    if (!planned.length) return null;
    return makeMessage({
      type: "mcm",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: { segments: planned.join(","), hops: planned.length },
      ttl: 2,
      createdTick: tick,
      signed: true,
      // Announcing a longer plan costs more air time, so the horizon is a real
      // trade rather than free foresight.
      variableBytes: planned.length * PATH_POINT_BYTES,
    });
  }

  receiveIntent(segmentIds: string[], tick: number) {
    for (const segId of segmentIds) {
      const prior = this.peerIntent.get(segId);
      const fresh = prior && tick - prior.tick <= INTENT_STALE_TICKS ? prior.claims : 0;
      this.peerIntent.set(segId, { claims: fresh + 1, tick });
    }
  }

  /** How many peers have recently said they are taking this road. */
  claimedByPeers(segmentId: string, tick: number): number {
    const entry = this.peerIntent.get(segmentId);
    if (!entry || tick - entry.tick > INTENT_STALE_TICKS) return 0;
    return entry.claims;
  }

  /** A stable per-vehicle, per-road perturbation in [0, ROUTE_JITTER).
   *
   *  Deterministic from the ids so a run stays reproducible from its seed,
   *  while different vehicles disagree about which of two equal-length roads
   *  to prefer. */
  private routeJitter(segmentId: string): number {
    const key = `${this.id}|${segmentId}`;
    let h = 2166136261;
    for (let i = 0; i < key.length; i++) {
      h ^= key.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (ROUTE_JITTER * ((h >>> 0) % 1000)) / 1000;
  }

  // --------------------------------------------------------- collision
  /** Involve this vehicle in a collision. The engine calls it on both
   *  parties at once. */
  crash(tick: number) {
    this.crashed = true;
    this.crashedAtTick = tick;
    this.recoveryTicks = RECOVERY_TICKS;
    this.brakingTicks = 0;
    this.dwellTicks = 0;
    this.yieldInstruction = null;
    this.glosaAdvice = null;
  }

  /** True once recovery has reached the wreck. The engine tows it away; the
   *  wreck never decides for itself that it is fine now. */
  get readyForRecovery(): boolean {
    return this.crashed && this.recoveryTicks === 0;
  }

  /** The wreck announcing itself: DENM causeCode 2, accident.
   *
   *  Confidence is 1.0 because the sender *is* the accident — the one hazard
   *  report that needs no corroborating witness to be certain, even though
   *  the network still corroborates it like any other. */
  private reportCrash(seg: Segment, tick: number): Message | null {
    if (tick % CRASH_REPORT_INTERVAL_TICKS !== 0) return null;
    const [causeCode, subCauseCode] = causeFor("accident");
    return makeMessage({
      type: "denm-hazard",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: {
        segment_id: seg.id,
        hazard_type: "accident",
        cause_code: causeCode,
        sub_cause_code: subCauseCode,
        confidence: 1,
      },
      ttl: 3,
      createdTick: tick,
      signed: true,
    });
  }

  // --------------------------------- Porsche 1: emergency brake light
  /** DENM cause 99/1, emergencyElectronicBrakeEngaged.
   *
   *  The rear-end case from the article: this car brakes because someone
   *  stepped out, and the car behind is told immediately rather than when its
   *  driver notices the brake lights. Public so tests can prove an attacker
   *  cannot emit one — EEBL is trusted implicitly by whoever receives it. */
  maybeReportBraking(seg: Segment, tick: number): Message | null {
    if (this.brakingTicks <= 0 || this.kind === "malicious") return null;
    const [causeCode, subCauseCode] = causeFor("hard_braking");
    return makeMessage({
      type: "denm-eebl",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: {
        segment_id: seg.id,
        hazard_type: "hard_braking",
        cause_code: causeCode,
        sub_cause_code: subCauseCode,
        confidence: 1,
      },
      ttl: 2, // only the traffic immediately behind needs this
      createdTick: tick,
      signed: true,
    });
  }

  // ------------------------------------ Porsche 2: collective perception
  /** TS 103 324 CPM: publish what this vehicle's sensors can see.
   *
   *  Only objects it can *actually* see are shared. Re-broadcasting what
   *  someone else told you would turn one sighting into a rumour with no
   *  source, which is precisely what the standard's confidence fields exist
   *  to prevent. */
  maybeSharePerception(tick: number): Message | null {
    const fresh = [...this.seenPedestrians.entries()]
      .filter(([, heard]) => tick - heard <= 1)
      .map(([segId]) => segId);
    if (!fresh.length || this.kind === "malicious") return null;
    const [causeCode, subCauseCode] = causeFor("pedestrian_crossing");
    return makeMessage({
      type: "cpm",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: {
        objects: fresh.length,
        segment_id: fresh[0],
        cause_code: causeCode,
        sub_cause_code: subCauseCode,
      },
      ttl: 2,
      createdTick: tick,
      signed: true,
      // The frame grows with everything you can see: collective perception is
      // a bandwidth trade, not a free win.
      variableBytes: fresh.length * PERCEIVED_OBJECT_BYTES,
    });
  }

  // ------------------------------------------------- Porsche 3: GLOSA
  /** Green Light Optimal Speed Advisory, from the SPaT already heard.
   *
   *  No new message type: the intersection is broadcasting its phase anyway,
   *  and this is what a vehicle can do with it. Arriving at a steady 30 km/h
   *  beats arriving at 50 and stopping. */
  glosaAdviceFor(nxt: string, tick: number, currentSpeed: number): number | null {
    const known = this.knownSignals.get(nxt);
    if (!known) return null;
    if (tick - known.tick > PEDESTRIAN_MEMORY_TICKS) return null; // may have changed
    if (known.phase !== "red") return null; // it is green, so just carry on
    if (1 - this.progress > GLOSA_APPROACH_PROGRESS) return null; // too far to matter
    // Ease off rather than race up to a red and brake.
    return Math.max(12, currentSpeed * 0.55);
  }

  /** An attacker's CAM is where false *traffic state* enters the network.
   *  Its hazard DENMs are caught by corroboration; this is the quieter
   *  channel, and it is the one that reaches the training data. */
  private reportedOccupancy(seg: Segment): number {
    return this.kind === "malicious" ? 1 - seg.occupancy : seg.occupancy;
  }

  private maybeShareOccupancy(seg: Segment, tick: number): Message | null {
    if (tick % OCCUPANCY_PING_INTERVAL_TICKS !== 0) return null;
    return makeMessage({
      type: "cam",
      senderId: this.id,
      pseudonym: this.pseudonym,
      payload: { segment_id: seg.id, occupancy: Math.round(this.reportedOccupancy(seg) * 1000) / 1000 },
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

  /** A peer's CPM told us about a road user. Kept apart from what we can see:
   *  the difference is exactly what collective perception buys. */
  receivePerceivedObject(segmentId: string, tick: number) {
    this.toldPedestrians.set(segmentId, tick);
  }

  /** SPaT from an intersection ahead. */
  receiveSignalPhase(node: string, phase: string, tick: number) {
    this.knownSignals.set(node, { phase, tick });
  }

  knowsPedestrianOn(segmentId: string | null, tick: number): boolean {
    if (!segmentId) return false;
    for (const source of [this.seenPedestrians, this.toldPedestrians]) {
      const heard = source.get(segmentId);
      if (heard !== undefined && tick - heard <= PEDESTRIAN_MEMORY_TICKS) return true;
    }
    return false;
  }

  /** True when the only reason it knows is that it was told — the turning
   *  case, where the corner blocks the view entirely. */
  pedestrianKnownOnlyFromPeers(segmentId: string | null, tick: number): boolean {
    if (!segmentId) return false;
    const seen = this.seenPedestrians.get(segmentId);
    if (seen !== undefined && tick - seen <= PEDESTRIAN_MEMORY_TICKS) return false;
    const told = this.toldPedestrians.get(segmentId);
    return told !== undefined && tick - told <= PEDESTRIAN_MEMORY_TICKS;
  }

  /** Begin a hard-braking manoeuvre — a pedestrian stepped into our path. */
  brakeHard() {
    this.brakingTicks = BRAKING_TICKS;
  }

  private recentWarning(segmentId: string, tick: number) {
    const heard = this.hazardWarnings.get(segmentId);
    return heard !== undefined && tick - heard <= PEER_INFO_STALE_TICKS;
  }

  /**
   * Divert around roads this vehicle has been warned about.
   *
   * The one rule that governs this: **the link under the wheels is already
   * committed.** Replanning from `node` lets the search answer "turn around",
   * and since `progress` is a fraction of whatever link the route now begins
   * with, a car 80% of the way down one road reappears 80% of the way down a
   * different one. That is the teleporting — not a drawing bug but a physics
   * one, and it is why this plans from the junction ahead and puts the current
   * link back in front of the answer.
   *
   * Public so a test can trigger a diversion at a known moment rather than
   * waiting for one to happen by chance.
   */
  reroute(tick: number): boolean {
    if (this.kind === "ambulance") return false;
    if (tick < this.rerouteCooldownUntil || this.route.length < 3) return false;

    // Roads still worth avoiding from an earlier decision, so a diversion is
    // not undone the moment the road it diverted onto reports in.
    const avoid = new Set<string>();
    for (const [segId, until] of this.avoiding) {
      if (tick < until) avoid.add(segId);
      else this.avoiding.delete(segId);
    }

    const upcoming = this.route.slice(1, REROUTE_LOOKAHEAD_HOPS + 2);
    const fresh = new Set<string>();
    for (let i = 0; i < upcoming.length - 1; i++) {
      const seg = this.grid.segmentBetween(upcoming[i], upcoming[i + 1]);
      if (this.recentWarning(seg.id, tick)) {
        fresh.add(seg.id);
        continue;
      }
      const info = this.knownOccupancy.get(seg.id);
      if (!info || tick - info.tick > PEER_INFO_STALE_TICKS) continue;
      if (info.occupancy >= CONGESTION_REROUTE_THRESHOLD) fresh.add(seg.id);
    }
    if (!fresh.size) return false;
    for (const segId of fresh) avoid.add(segId);

    // Part-way down a road, the only thing still open is what happens after
    // the junction ahead; at a junction, everything is open.
    const committed = this.progress > 0 && this.nextNode !== null;
    const from = committed ? this.nextNode! : this.node;
    const tail = this.detour(avoid, tick, from);
    if (!tail.length) return false;
    const newRoute = committed ? [this.node, ...tail] : tail;

    if (newRoute.join() === this.route.join()) return false;
    this.route = newRoute;
    for (const segId of fresh) this.avoiding.set(segId, tick + AVOID_COMMIT_TICKS);
    this.rerouteCooldownUntil = tick + REROUTE_COOLDOWN_TICKS;
    this.rerouteCount += 1;
    this.lastDiversion = {
      tick,
      avoided: [...fresh],
      reason: [...fresh].some((segId) => this.recentWarning(segId, tick))
        ? "a hazard a peer reported"
        : "congestion a peer reported",
    };
    return true;
  }

  /** The most recent diversion and what caused it, for the explanation panel.
   *  Cleared by nothing: the last decision a vehicle made stays inspectable. */
  lastDiversion: { tick: number; avoided: string[]; reason: string } | null = null;

  /**
   * Pick a way around the roads this vehicle has been warned about.
   *
   * Without coordination this is a breadth-first search, so two vehicles in
   * the same place heading the same way get byte-identical detours — and a
   * whole platoon arrives on the same alternative at once. That is the herding
   * effect, and it is why greedy rerouting can be *worse* than not rerouting.
   *
   * With coordination the same search is weighted by what peers have
   * announced, and tie-broken per vehicle. Public so the tests can show the
   * herding and its fix directly.
   */
  detour(avoid: Set<string>, tick: number, from: string = this.node): string[] {
    if (from === this.destination) return [from];
    if (!this.intentCoordination)
      return this.grid.shortestPathAvoiding(from, this.destination, avoid);

    const cost = (seg: Segment) =>
      seg.lengthM *
      (avoid.has(seg.id) ? AVOID_SEGMENT_PENALTY : 1) *
      (1 + INTENT_CLAIM_WEIGHT * this.claimedByPeers(seg.id, tick)) *
      (1 + this.routeJitter(seg.id));

    const route = this.grid.leastCostPath(from, this.destination, cost);
    // Unreachable under this cost (it should not be, since nothing is banned
    // outright) — fall back rather than strand the vehicle.
    return route.length ? route : this.grid.shortestPathAvoiding(from, this.destination, avoid);
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
      braking: this.brakingTicks > 0,
      glosa_advice: this.glosaAdvice === null ? null : Math.round(this.glosaAdvice * 10) / 10,
      crashed: this.crashed,
      recovery_ticks: this.recoveryTicks,
      parked: this.dwellTicks > 0,
      trip_purpose: this.tripPurpose,
      // What this vehicle last decided and why, so a viewer can click a car
      // and be told the reason rather than left to infer it from the map.
      last_diversion: this.lastDiversion,
    };
  }
}

// --------------------------------------------------------------- RSU
const DIGEST_INTERVAL_TICKS = 10;
/** Beyond this, a peer's occupancy report is too old to train on. */
const REPORT_STALE_TICKS = 15;
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
  /** segment id -> what peers *said*, when, and how much they are believed. */
  reportedOccupancy = new Map<string, { occupancy: number; tick: number; trust: number }>();

  collectTrainingSamples(predictor: CongestionPredictor, tick: number, sourceTrust = 1) {
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
      if (!seg) continue;
      // Train on the believed road state, not on ground truth an RSU could
      // never see. This is the channel a false CAM travels down.
      const reported = this.reportedOccupancy.get(segId);
      const fresh = reported && tick - reported.tick <= REPORT_STALE_TICKS;
      const target = fresh ? reported!.occupancy : seg.occupancy;
      // Nobody reported it recently: fall back to what the RSU measures
      // itself, which is beyond an attacker's reach.
      const sampleTrust = fresh ? reported!.trust : 1;
      this.flClient.observe(feats, target, Math.min(sampleTrust, sourceTrust));
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

  /** Phase offset for this junction, from its coordinates.
   *
   *  Without it every light in the city turned red at the same instant, which
   *  is both unrealistic and useless to demonstrate against: a vehicle could
   *  never meet a red one junction and a green the next. Offsetting by
   *  position is also roughly what a real grid does to create a green wave. */
  get offset(): number {
    const parts = this.node.split("-").map(Number);
    if (parts.length !== 2 || parts.some(Number.isNaN)) return 0;
    return ((parts[0] + parts[1]) * Math.floor(CYCLE_TICKS / 2)) % (CYCLE_TICKS * 2);
  }

  step(tick: number) {
    if (tick <= this.preemptedUntil) {
      this.phase = "green";
      return;
    }
    this.preemptReason = "";
    this.phase = Math.floor((tick + this.offset) / CYCLE_TICKS) % 2 === 0 ? "green" : "red";
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

export interface SignalRequest {
  requestId: string;
  ambulanceId: string;
  intersection: string;
  etaSeconds: number;
  holdTicks: number;
}

export class EmergencyCorridorManager {
  activeCorridors = new Set<string>();
  /** Frames raised this tick, drained by the engine so they are transmitted
   *  and paid for like any other broadcast. */
  pendingFrames: Message[] = [];
  /** Priority requests awaiting transmission as SREM. The corridor no longer
   *  reaches into a TrafficLight and preempts it; it asks over the air, and
   *  the ask can be lost or refused. */
  pendingRequests: SignalRequest[] = [];
  private requestSeq = 0;

  constructor(private grid: CityGrid) {}

  /** Hand the engine everything raised since the last drain. */
  drainFrames(): Message[] {
    const frames = this.pendingFrames;
    this.pendingFrames = [];
    return frames;
  }

  /** Hand the engine the priority requests to put on the air as SREM. */
  drainRequests(): SignalRequest[] {
    const requests = this.pendingRequests;
    this.pendingRequests = [];
    return requests;
  }

  step(tick: number, ambulances: Vehicle[], allVehicles: Vehicle[], lights: Map<string, TrafficLight>) {
    const activeIds = new Set(ambulances.map((a) => a.id));
    for (const id of this.activeCorridors) if (!activeIds.has(id)) this.activeCorridors.delete(id);

    const corridorSegments = new Set<string>();
    for (const amb of ambulances) {
      const isNewCorridor = !this.activeCorridors.has(amb.id);
      this.activeCorridors.add(amb.id);
      const route = amb.route.slice(0, LOOKAHEAD_NODES);
      if (isNewCorridor) {
        this.pendingFrames.push(
          makeMessage({
            type: "denm-eva",
            senderId: amb.id,
            pseudonym: amb.pseudonym,
            payload: {
              ambulance_id: amb.id,
              cause_code: CAUSE_CODE.EMERGENCY_VEHICLE_APPROACHING,
              sub_cause_code: 0,
            },
            ttl: this.grid.size * 2,
            createdTick: tick,
            signed: true,
            // The predicted path and its ETA table are what make this frame
            // bigger than a plain hazard DENM.
            variableBytes: route.length * PATH_POINT_BYTES,
          }),
        );
      }
      const eta = new Map<string, number>();
      let cumulative = 0;
      for (let i = 0; i < route.length - 1; i++) {
        const seg = this.grid.segmentBetween(route[i], route[i + 1]);
        cumulative += seg.lengthM;
        eta.set(route[i + 1], Math.round((cumulative / ((amb.speedKmh * 1000) / 3600)) * 10) / 10);
        corridorSegments.add(seg.id);
        if (lights.has(route[i + 1])) {
          // TS 103 301: ask the intersection over the air. Whether it grants
          // -- or hears at all -- is decided when the SREM is transmitted.
          this.requestSeq += 1;
          this.pendingRequests.push({
            requestId: `srem-${this.requestSeq}`,
            ambulanceId: amb.id,
            intersection: route[i + 1],
            etaSeconds: eta.get(route[i + 1]) ?? 0,
            holdTicks: PREEMPT_HOLD_TICKS,
          });
        }
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
