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
export type MessageType =
  | "hazard_report"
  | "occupancy_ping"
  | "telemetry_upload"
  | "emergency_broadcast";

const SECURITY_HEADER_BYTES = 96;
const BASE_HEADER_BYTES = 24;
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
}

export function makeMessage(m: Omit<Message, "id">): Message {
  return { ...m, id: `msg-${msgCounter++}` };
}

export function messageBytes(m: Message): number {
  let payloadBytes = 0;
  for (const [k, v] of Object.entries(m.payload)) payloadBytes += k.length + String(v).length;
  return BASE_HEADER_BYTES + payloadBytes + (m.signed ? SECURITY_HEADER_BYTES : 0);
}
