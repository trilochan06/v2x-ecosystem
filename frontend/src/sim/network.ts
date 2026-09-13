/** M2 radio, M11 security, and corroboration-based trust. Ported from
 *  `backend/app/network/`. */
import { CityGrid, Message, Rng, messageBytes } from "./core";

// ---------------------------------------------------- M2 radio (gossip)
const DEDUP_TTL_TICKS = 40;
const BASE_LINK_RELIABILITY = 0.97;
const CONTENTION_PENALTY = 0.45;

export interface RecipientHandle {
  nodeId: string;
  gridNode: string;
  isAlive: boolean;
}

export class EtherBus {
  private seen = new Map<string, Map<string, number>>();

  constructor(
    private grid: CityGrid,
    private rng: Rng,
  ) {}

  register(nodeId: string) {
    if (!this.seen.has(nodeId)) this.seen.set(nodeId, new Map());
  }

  private cache(nodeId: string) {
    if (!this.seen.has(nodeId)) this.seen.set(nodeId, new Map());
    return this.seen.get(nodeId)!;
  }

  private prune(nodeId: string, tick: number) {
    const c = this.cache(nodeId);
    for (const [mid, exp] of c) if (exp <= tick) c.delete(mid);
  }

  private hopRadius(origin: string, maxHops: number): Map<string, number> {
    const dist = new Map([[origin, 0]]);
    let frontier = [origin];
    for (let d = 0; d < maxHops; d++) {
      const next: string[] = [];
      for (const node of frontier)
        for (const nb of this.grid.neighbors(node))
          if (!dist.has(nb)) {
            dist.set(nb, d + 1);
            next.push(nb);
          }
      frontier = next;
      if (!frontier.length) break;
    }
    return dist;
  }

  /** Delivery falls off with hop distance (path loss) and with local
   *  transmitter density (contention) — the "reliability in dense
   *  environments" problem, and what makes PDR a real measurement. */
  deliveryProbability(hops: number, channelLoad: number): number {
    const perHop = BASE_LINK_RELIABILITY ** Math.max(hops, 1);
    const contention = Math.max(0, 1 - CONTENTION_PENALTY * Math.min(channelLoad, 1));
    return Math.max(0.05, perHop * contention);
  }

  broadcast(
    msg: Message,
    originGridNode: string,
    tick: number,
    recipients: RecipientHandle[],
    channelLoad = 0,
  ): { delivered: string[]; intended: number } {
    const reach = this.hopRadius(originGridNode, Math.max(msg.ttl, 0));
    const delivered: string[] = [];
    let intended = 0;

    for (const r of recipients) {
      if (!r.isAlive) continue;
      const hops = reach.get(r.gridNode);
      if (hops === undefined) continue;
      this.prune(r.nodeId, tick);
      if (this.cache(r.nodeId).has(msg.id)) continue;

      intended += 1;
      if (this.rng.next() > this.deliveryProbability(hops, channelLoad)) continue;

      this.cache(r.nodeId).set(msg.id, tick + DEDUP_TTL_TICKS);
      delivered.push(r.nodeId);
    }
    return { delivered, intended };
  }
}

// ------------------------------------------------------- M11 security
const PSEUDONYM_LIFETIME_TICKS = 40;
const FRESHNESS_WINDOW_TICKS = 8;

interface Certificate {
  pseudonym: string;
  issuedTick: number;
  expiresTick: number;
}

/** Issues short-lived certificates and is the only party that can link a
 *  pseudonym back to the vehicle behind it. */
export class PseudonymAuthority {
  private active = new Map<string, Certificate>();
  private linkage = new Map<string, string>();
  private history = new Map<string, number>();
  revoked = new Set<string>();
  issuedCount = 0;
  rotationCount = 0;
  private counter = 0;

  constructor(
    private rng: Rng,
    readonly lifetimeTicks = PSEUDONYM_LIFETIME_TICKS,
  ) {}

  private issue(vehicleId: string, tick: number, rotation: boolean): Certificate {
    const cert: Certificate = {
      pseudonym: `pid-${(this.counter++).toString(36)}${Math.floor(this.rng.next() * 1e6).toString(36)}`,
      issuedTick: tick,
      expiresTick: tick + this.lifetimeTicks,
    };
    this.active.set(vehicleId, cert);
    this.linkage.set(cert.pseudonym, vehicleId);
    this.history.set(vehicleId, (this.history.get(vehicleId) ?? 0) + 1);
    this.issuedCount += 1;
    if (rotation) this.rotationCount += 1;
    return cert;
  }

  enroll(vehicleId: string, tick: number) {
    return this.issue(vehicleId, tick, false);
  }

  certificateFor(vehicleId: string, tick: number): Certificate {
    const cert = this.active.get(vehicleId);
    if (!cert) return this.issue(vehicleId, tick, false);
    if (tick > cert.expiresTick) return this.issue(vehicleId, tick, true);
    return cert;
  }

  rotateExpired(vehicleIds: string[], tick: number): string[] {
    const rotated: string[] = [];
    for (const id of vehicleIds) {
      const cert = this.active.get(id);
      if (!cert || tick > cert.expiresTick) {
        this.issue(id, tick, Boolean(cert));
        rotated.push(id);
      }
    }
    return rotated;
  }

  /** An RSU can confirm a pseudonym was validly issued and is not revoked.
   *  It learns nothing about which vehicle it belongs to. */
  verify(pseudonym: string, tick: number): boolean {
    const vehicleId = this.linkage.get(pseudonym);
    if (!vehicleId || this.revoked.has(vehicleId)) return false;
    const cert = this.active.get(vehicleId);
    return Boolean(cert && cert.pseudonym === pseudonym && tick <= cert.expiresTick);
  }

  revoke(vehicleId: string) {
    this.revoked.add(vehicleId);
  }

  snapshot(vehicleCount: number) {
    const counts = [...this.history.values()];
    const avg = counts.length ? counts.reduce((a, b) => a + b, 0) / counts.length : 0;
    return {
      certificates_issued: this.issuedCount,
      rotations: this.rotationCount,
      lifetime_ticks: this.lifetimeTicks,
      avg_pseudonyms_per_vehicle: Math.round(avg * 100) / 100,
      revoked_vehicles: this.revoked.size,
      tracked_vehicles: vehicleCount,
    };
  }
}

/** Freshness window + per-receiver nonce memory. The nonce memory is keyed by
 *  receiver: one broadcast legitimately arrives at many nodes, and only a
 *  repeat arrival at the *same* node is a replay. */
export class ReplayGuard {
  private seen = new Map<string, number>();
  replaysBlocked = 0;
  staleDropped = 0;
  accepted = 0;

  constructor(readonly freshnessWindow = FRESHNESS_WINDOW_TICKS) {}

  accept(receiverId: string, messageId: string, createdTick: number, now: number): boolean {
    if (now - createdTick > this.freshnessWindow || createdTick > now) {
      this.staleDropped += 1;
      return false;
    }
    const key = `${receiverId}|${messageId}`;
    if (this.seen.has(key)) {
      this.replaysBlocked += 1;
      return false;
    }
    this.seen.set(key, now + this.freshnessWindow * 4);
    this.accepted += 1;
    return true;
  }

  prune(now: number) {
    for (const [k, exp] of this.seen) if (exp <= now) this.seen.delete(k);
  }

  snapshot() {
    const total = this.accepted + this.replaysBlocked + this.staleDropped;
    return {
      accepted: this.accepted,
      replays_blocked: this.replaysBlocked,
      stale_dropped: this.staleDropped,
      rejection_rate_pct: total
        ? Math.round(((this.replaysBlocked + this.staleDropped) / total) * 10000) / 100
        : 0,
      freshness_window_ticks: this.freshnessWindow,
    };
  }
}

// ------------------------------------------------------------- trust
const TRUST_INITIAL = 1.0;
const TRUST_QUARANTINE_THRESHOLD = 0.35;
const TRUST_REVOCATION_THRESHOLD = 0.12;
const TRUST_REVOCATION_MIN_REPORTS = 10;
const TRUST_MIN_SAMPLES = 4;
const TRUST_EMA_ALPHA = 0.2;

export class TrustRegistry {
  scores = new Map<string, number>();
  seen = new Map<string, number>();
  corroborated = new Map<string, number>();

  register(id: string) {
    if (!this.scores.has(id)) {
      this.scores.set(id, TRUST_INITIAL);
      this.seen.set(id, 0);
      this.corroborated.set(id, 0);
    }
  }

  score(id: string) {
    return this.scores.get(id) ?? TRUST_INITIAL;
  }

  isTrusted(id: string) {
    return this.score(id) >= TRUST_QUARANTINE_THRESHOLD;
  }

  shouldRevoke(id: string) {
    return (
      (this.seen.get(id) ?? 0) >= TRUST_REVOCATION_MIN_REPORTS &&
      this.score(id) < TRUST_REVOCATION_THRESHOLD
    );
  }

  recordReport(id: string, corroborated: boolean) {
    this.register(id);
    this.seen.set(id, (this.seen.get(id) ?? 0) + 1);
    if (corroborated) this.corroborated.set(id, (this.corroborated.get(id) ?? 0) + 1);

    const n = this.seen.get(id)!;
    if (n < TRUST_MIN_SAMPLES) return;
    const rate = this.corroborated.get(id)! / n;
    const current = this.scores.get(id)!;
    this.scores.set(id, Math.round((current + (rate - current) * TRUST_EMA_ALPHA) * 10000) / 10000);
  }

  snapshot() {
    const out: Record<string, {
      trust_score: number;
      reports_seen: number;
      reports_corroborated: number;
      quarantined: boolean;
    }> = {};
    for (const [id, score] of this.scores)
      out[id] = {
        trust_score: score,
        reports_seen: this.seen.get(id) ?? 0,
        reports_corroborated: this.corroborated.get(id) ?? 0,
        quarantined: score < TRUST_QUARANTINE_THRESHOLD,
      };
    return out;
  }
}

// ------------------------------------------------------ corroboration
const CORROBORATION_WINDOW_TICKS = 10;
export const INCIDENT_DURATION_TICKS = 50;

interface MetricsSink {
  incidentConfirmed(segmentId: string, tick: number, hazardActive: boolean): void;
}

/** "Nobody confirmed this" and "nobody could have confirmed this" look
 *  identical in the data and mean opposite things. Scoring them the same way
 *  destroys the reputation of honest vehicles on quiet streets, so a report no
 *  other vehicle was positioned to witness leaves trust untouched. */
export class CorroborationEngine {
  private recent: { tick: number; sender: string; segmentId: string }[] = [];
  private scored = new Map<string, number>();
  newlyConfirmed = new Set<string>();
  unwitnessedReports = 0;

  process(
    reports: { senderId: string; msg: Message }[],
    trust: TrustRegistry,
    grid: CityGrid,
    tick: number,
    metrics?: MetricsSink,
    witnesses?: Map<string, Set<string>>,
  ): Set<string> {
    this.recent = this.recent.filter((r) => tick - r.tick <= CORROBORATION_WINDOW_TICKS);
    for (const [k, t] of this.scored)
      if (tick - t > CORROBORATION_WINDOW_TICKS * 3) this.scored.delete(k);

    for (const { senderId, msg } of reports)
      this.recent.push({ tick, sender: senderId, segmentId: String(msg.payload.segment_id) });

    const bySegment = new Map<string, typeof this.recent>();
    for (const r of this.recent) {
      if (!bySegment.has(r.segmentId)) bySegment.set(r.segmentId, []);
      bySegment.get(r.segmentId)!.push(r);
    }

    const confirmed = new Set<string>();
    for (const { senderId, msg } of reports) {
      const segId = String(msg.payload.segment_id);
      const others = (bySegment.get(segId) ?? []).filter((r) => r.sender !== senderId);
      const corroborated = others.length >= 1;

      let couldBeWitnessed = true;
      if (witnesses) {
        const set = witnesses.get(segId);
        couldBeWitnessed = Boolean(set && [...set].some((v) => v !== senderId));
      }

      const key = `${senderId}|${segId}`;
      const lastScored = this.scored.get(key);
      const isRepeat = lastScored !== undefined && tick - lastScored <= CORROBORATION_WINDOW_TICKS;

      if (isRepeat) {
        // same observation, already counted
      } else if (corroborated || couldBeWitnessed) {
        trust.recordReport(senderId, corroborated);
        this.scored.set(key, tick);
      } else {
        this.unwitnessedReports += 1;
      }

      if (corroborated && trust.isTrusted(senderId)) confirmed.add(segId);
    }

    const newly = new Set<string>();
    for (const segId of confirmed) {
      const seg = grid.segments.get(segId);
      if (!seg) continue;
      if (seg.confirmIncident(tick, INCIDENT_DURATION_TICKS)) newly.add(segId);
      metrics?.incidentConfirmed(segId, tick, seg.hazardActive);
    }
    this.newlyConfirmed = newly;
    return confirmed;
  }
}

export { messageBytes };
