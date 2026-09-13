/** Seeded RNG, road network and wire messages.
 *
 * This is a TypeScript port of the Python engine under `backend/app/`, so the
 * whole system can run client-side and the site deploys as a static bundle.
 * It mirrors the Python module for module; where behaviour must match exactly
 * (the congestion model, the federated validation set) the artefacts are
 * exported from the trained Python model rather than reimplemented.
 */

// ----------------------------------------------------------------- RNG
/** mulberry32 — small, fast, and seedable, so a given seed reproduces a run. */
export function makeRng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: <T,>(xs: T[]): T => xs[Math.floor(next() * xs.length)],
    gauss: (mu: number, sigma: number) => {
      const u = Math.max(next(), 1e-12);
      const v = next();
      return mu + sigma * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
    },
  };
}
export type Rng = ReturnType<typeof makeRng>;

export const HAZARD_TYPES = [
  "accident",
  "stalled_vehicle",
  "hard_braking",
  "waterlogging",
  "oil_spill",
  "fog_bank",
];

// --------------------------------------------------------------- world
export const nodeId = (x: number, y: number) => `${x}-${y}`;

export class Segment {
  occupancy = 0;
  hazardActive = false;
  hazardType = "";
  hazardTtl = 0;
  hazardStartedTick = -1;
  confirmedIncident = false;
  confirmedTick = -1;
  confirmedTtl = 0;
  history: number[] = [];

  constructor(
    readonly id: string,
    readonly a: string,
    readonly b: string,
    readonly lengthM = 250,
  ) {}

  record() {
    this.history.push(this.occupancy);
    if (this.history.length > 240) this.history.shift();
  }

  raiseHazard(type: string, ttl: number, tick: number) {
    this.hazardActive = true;
    this.hazardType = type;
    this.hazardTtl = ttl;
    this.hazardStartedTick = tick;
  }

  clearHazard() {
    this.hazardActive = false;
    this.hazardType = "";
    this.hazardTtl = 0;
    this.hazardStartedTick = -1;
  }

  /** Returns true the first time this belief is raised (latency accounting). */
  confirmIncident(tick: number, ttl: number): boolean {
    const first = !this.confirmedIncident;
    this.confirmedIncident = true;
    this.confirmedTtl = ttl;
    if (first) this.confirmedTick = tick;
    return first;
  }

  tickDown() {
    if (this.hazardActive && --this.hazardTtl <= 0) this.clearHazard();
    if (this.confirmedIncident && --this.confirmedTtl <= 0) {
      this.confirmedIncident = false;
      this.confirmedTick = -1;
    }
  }
}

export class CityGrid {
  nodes = new Map<string, [number, number]>();
  segments = new Map<string, Segment>();
  adjacency = new Map<string, string[]>();

  constructor(readonly size = 6) {
    for (let x = 0; x < size; x++)
      for (let y = 0; y < size; y++) {
        this.nodes.set(nodeId(x, y), [x, y]);
        this.adjacency.set(nodeId(x, y), []);
      }
    for (let x = 0; x < size; x++)
      for (let y = 0; y < size; y++) {
        if (x + 1 < size) this.addSegment(nodeId(x, y), nodeId(x + 1, y));
        if (y + 1 < size) this.addSegment(nodeId(x, y), nodeId(x, y + 1));
      }
  }

  private addSegment(a: string, b: string) {
    this.segments.set(`${a}_${b}`, new Segment(`${a}_${b}`, a, b));
    this.adjacency.get(a)!.push(b);
    this.adjacency.get(b)!.push(a);
  }

  segmentBetween(a: string, b: string): Segment {
    return this.segments.get(`${a}_${b}`) ?? this.segments.get(`${b}_${a}`)!;
  }

  neighbors(n: string) {
    return this.adjacency.get(n) ?? [];
  }

  coords(n: string) {
    return this.nodes.get(n)!;
  }

  euclidean(a: string, b: string) {
    const [ax, ay] = this.coords(a);
    const [bx, by] = this.coords(b);
    return Math.hypot(ax - bx, ay - by) * 250;
  }

  allSegments() {
    return [...this.segments.values()];
  }

  shortestPath(start: string, goal: string) {
    return this.shortestPathAvoiding(start, goal, new Set());
  }

  shortestPathAvoiding(start: string, goal: string, avoid: Set<string>): string[] {
    if (start === goal) return [start];
    const visited = new Set([start]);
    const queue: string[][] = [[start]];
    while (queue.length) {
      const path = queue.shift()!;
      const node = path[path.length - 1];
      for (const nxt of this.neighbors(node)) {
        if (visited.has(nxt)) continue;
        if (avoid.size && avoid.has(this.segmentBetween(node, nxt).id)) continue;
        const newPath = [...path, nxt];
        if (nxt === goal) return newPath;
        visited.add(nxt);
        queue.push(newPath);
      }
    }
    return avoid.size ? this.shortestPathAvoiding(start, goal, new Set()) : [start];
  }

  /** Every other segment sharing an endpoint — the spillover neighbourhood. */
  adjacentSegments(seg: Segment): Segment[] {
    const seen = new Set([seg.id]);
    const out: Segment[] = [];
    for (const node of [seg.a, seg.b])
      for (const nb of this.neighbors(node)) {
        const s = this.segmentBetween(node, nb);
        if (!seen.has(s.id)) {
          seen.add(s.id);
          out.push(s);
        }
      }
    return out;
  }

  decayOccupancy(factor = 0.985) {
    for (const s of this.segments.values()) {
      s.occupancy = Math.max(0, s.occupancy * factor);
      s.record();
    }
  }
}

// ------------------------------------------------------------ messages
// The ETSI cooperative-ITS message set. Mirrors
// backend/app/network/messages.py -- see that module for the standards, the
// ASN.1 UPER sizing and why certificate attachment is modelled.

/** Which radio or link a frame travels over. */
export type Bearer = "its-g5" | "backhaul";

export type MessageType = "cam" | "denm-hazard" | "denm-eva" | "telemetry-upload";

export interface MessageSpec {
  designator: string;
  standard: string;
  label: string;
  bearer: Bearer;
  /** Representative ASN.1 UPER payload, excluding header and security. */
  payloadBytes: number;
}

export const MESSAGE_SPECS: Record<MessageType, MessageSpec> = {
  cam: {
    designator: "CAM",
    standard: "ETSI EN 302 637-2",
    label: "Cooperative awareness",
    bearer: "its-g5",
    payloadBytes: 117,
  },
  "denm-hazard": {
    designator: "DENM",
    standard: "ETSI EN 302 637-3",
    label: "Hazard notification",
    bearer: "its-g5",
    payloadBytes: 180,
  },
  "denm-eva": {
    designator: "DENM",
    standard: "ETSI EN 302 637-3",
    label: "Emergency vehicle approaching",
    bearer: "its-g5",
    payloadBytes: 180,
  },
  "telemetry-upload": {
    designator: "probe",
    standard: "non-standard backhaul",
    label: "Raw probe-data upload",
    bearer: "backhaul",
    payloadBytes: 72,
  },
};

export const ITS_PDU_HEADER_BYTES = 4;
export const BACKHAUL_FRAMING_BYTES = 20;
export const SIGNATURE_BYTES = 64;
export const SIGNED_DATA_OVERHEAD_BYTES = 17;
export const CERTIFICATE_BYTES = 117;
export const CERTIFICATE_DIGEST_BYTES = 8;
export const CERT_ATTACH_INTERVAL_MESSAGES = 10;
/** One waypoint of a predicted emergency path plus its ETA. */
export const PATH_POINT_BYTES = 12;

/** DENM causeCode values from the TS 102 894-2 Common Data Dictionary. */
export const CAUSE_CODE = {
  ACCIDENT: 2,
  ADVERSE_WEATHER_ADHESION: 6,
  HAZARDOUS_LOCATION_SURFACE_CONDITION: 9,
  ADVERSE_WEATHER_VISIBILITY: 19,
  STATIONARY_VEHICLE: 94,
  EMERGENCY_VEHICLE_APPROACHING: 95,
  DANGEROUS_SITUATION: 99,
} as const;

/** Hazard vocabulary mapped onto (causeCode, subCauseCode). */
export const HAZARD_CAUSE_CODES: Record<string, [number, number]> = {
  accident: [CAUSE_CODE.ACCIDENT, 0],
  stalled_vehicle: [CAUSE_CODE.STATIONARY_VEHICLE, 2], // vehicleBreakdown
  hard_braking: [CAUSE_CODE.DANGEROUS_SITUATION, 1], // emergencyElectronicBrakeEngaged
  waterlogging: [CAUSE_CODE.HAZARDOUS_LOCATION_SURFACE_CONDITION, 0], // no CDD subcause
  oil_spill: [CAUSE_CODE.ADVERSE_WEATHER_ADHESION, 2], // fuelOnTheRoad
  fog_bank: [CAUSE_CODE.ADVERSE_WEATHER_VISIBILITY, 1], // fog
};

export function causeFor(hazardType: string): [number, number] {
  return HAZARD_CAUSE_CODES[hazardType] ?? [CAUSE_CODE.DANGEROUS_SITUATION, 0];
}

let msgCounter = 1;

export interface Message {
  id: string;
  type: MessageType;
  senderId: string;
  pseudonym: string;
  payload: Record<string, string | number>;
  ttl: number;
  createdTick: number;
  signed: boolean;
  /** Content whose size genuinely varies: an emergency path, a probe batch. */
  variableBytes: number;
  /** Set before the frame goes on the air, by CertificateAttachmentPolicy. */
  certificateAttached: boolean;
}

type MessageInit = Omit<Message, "id" | "variableBytes" | "certificateAttached"> &
  Partial<Pick<Message, "variableBytes" | "certificateAttached">>;

export function makeMessage(m: MessageInit): Message {
  return { variableBytes: 0, certificateAttached: false, ...m, id: `msg-${msgCounter++}` };
}

export function messageSpec(m: Message): MessageSpec {
  return MESSAGE_SPECS[m.type];
}

/** The 1609.2 / TS 103 097 envelope. Backhaul frames ride TLS and pay none. */
export function securityBytes(m: Message): number {
  const spec = MESSAGE_SPECS[m.type];
  if (!m.signed || spec.bearer !== "its-g5") return 0;
  const credential = m.certificateAttached ? CERTIFICATE_BYTES : CERTIFICATE_DIGEST_BYTES;
  return SIGNATURE_BYTES + SIGNED_DATA_OVERHEAD_BYTES + credential;
}

export function messageBytes(m: Message): number {
  const spec = MESSAGE_SPECS[m.type];
  const framing = spec.bearer === "its-g5" ? ITS_PDU_HEADER_BYTES : BACKHAUL_FRAMING_BYTES;
  return framing + spec.payloadBytes + m.variableBytes + securityBytes(m);
}

/** What a frame's content costs uploaded over TLS instead of broadcast. */
export function backhaulBytes(m: Message): number {
  return BACKHAUL_FRAMING_BYTES + MESSAGE_SPECS[m.type].payloadBytes + m.variableBytes;
}

/**
 * Decides whether a frame carries a full certificate or an 8-byte digest.
 *
 * Keyed by pseudonym, so rotating one invalidates the receivers' cached
 * certificate and forces a re-attach -- the bandwidth price of unlinkability.
 */
export class CertificateAttachmentPolicy {
  private counts = new Map<string, number>();
  certificatesAttached = 0;
  digestsAttached = 0;

  constructor(private readonly interval = CERT_ATTACH_INTERVAL_MESSAGES) {
    this.interval = Math.max(1, interval);
  }

  attach(stationKey: string): boolean {
    const seen = this.counts.get(stationKey) ?? 0;
    this.counts.set(stationKey, seen + 1);
    const full = seen % this.interval === 0;
    if (full) this.certificatesAttached++;
    else this.digestsAttached++;
    return full;
  }

  get bytesSaved(): number {
    return this.digestsAttached * (CERTIFICATE_BYTES - CERTIFICATE_DIGEST_BYTES);
  }

  snapshot() {
    return {
      frames_secured: this.certificatesAttached + this.digestsAttached,
      certificates_attached: this.certificatesAttached,
      digests_attached: this.digestsAttached,
      attach_interval: this.interval,
      kilobytes_saved: Math.round((this.bytesSaved / 1024) * 100) / 100,
    };
  }
}
