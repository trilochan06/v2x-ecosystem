/**
 * Why the system did what it did.
 *
 * The site could already show *what* was happening — a road turns red, a car
 * changes course, a counter goes up. What it could not do is say why, and a
 * system nobody can interrogate is one nobody should trust. Two structures
 * fix that, and they cover the two different kinds of "why" this project has.
 *
 * `DecisionLedger` is the rule half. Every consequential decision writes down
 * the evidence it had, the rule it applied with the threshold it actually
 * tested, and what changed as a result. Nothing here is generated after the
 * fact or reconstructed from the outcome: the record is written at the moment
 * the decision is taken, by the code that takes it.
 *
 * `incidentDossier` is the belief half. For one road it puts the network's
 * belief next to the ground truth the simulator holds privately, and says
 * whether they agree. That comparison is the only reason a fabricated hazard
 * is visible as a fabrication rather than as an ordinary incident — it is the
 * mechanism behind the precision figure, made inspectable one road at a time.
 *
 * The congestion model's own feature attributions are the third leg and live
 * with the model, in `ai.ts`.
 */
import { CAUSE_CODE, CityGrid, LAND_USE_LABEL, Segment, causeFor, junctionName, roadName } from "./core";
import type { TrustRegistry } from "./network";

export type DecisionKind =
  | "report"
  | "confirm"
  | "divert"
  | "warn"
  | "brake"
  | "perceive"
  | "priority"
  | "trust"
  | "revoke"
  | "collision"
  | "recovery"
  | "attack"
  | "outage";

/** One decision, with everything needed to argue about it. */
export interface Decision {
  id: number;
  tick: number;
  kind: DecisionKind;
  /** Who or what the decision is about — a vehicle, segment or RSU id. */
  subject: string;
  /** Where on the map it happened, so a panel can anchor to it. */
  where: string | null;
  /** One sentence, in the words a person would use. */
  headline: string;
  /** What was actually observed, each item carrying its numbers. */
  evidence: string[];
  /** The rule that fired, quoted with the threshold it tested. */
  rule: string;
  /** What changed because of it. */
  effect: string;
}

const LEDGER_LIMIT = 140;

export class DecisionLedger {
  private entries: Decision[] = [];
  private counter = 1;

  record(d: Omit<Decision, "id">): Decision {
    const entry = { ...d, id: this.counter++ };
    this.entries.push(entry);
    if (this.entries.length > LEDGER_LIMIT) this.entries.shift();
    return entry;
  }

  /** Newest first — which is the order anyone reads a feed in. */
  recent(limit = 30): Decision[] {
    return this.entries.slice(-limit).reverse();
  }

  /** Everything said about one vehicle, road or unit. */
  forSubject(subject: string, limit = 12): Decision[] {
    return this.entries
      .filter((d) => d.subject === subject || d.where === subject)
      .slice(-limit)
      .reverse();
  }

  get size() {
    return this.entries.length;
  }
}

// ---------------------------------------------------------- dossiers
/** Whether the network's belief about a road matches the world. */
export type IncidentVerdict = "confirmed-real" | "confirmed-false" | "unreported" | "clear";

export interface Witness {
  /** The identity actually on the air. Nobody, including this panel, gets to
   *  see the vehicle behind it — that is what the pseudonym is for. */
  pseudonym: string;
  trust: number;
  tick: number;
  confidence: number;
}

export interface IncidentDossier {
  segment_id: string;
  road: string;
  district: string;
  /** What is physically true. The simulator knows; the network does not, and
   *  that gap is the whole measurement. */
  ground_truth: boolean;
  ground_truth_type: string;
  /** What the network currently believes. */
  believed: boolean;
  verdict: IncidentVerdict;
  verdict_text: string;
  cause_code: number | null;
  sub_cause_code: number | null;
  first_reported_tick: number | null;
  confirmed_tick: number | null;
  /** Ticks from the hazard appearing to the network believing in it. */
  latency_ticks: number | null;
  witnesses: Witness[];
  distinct_witnesses: number;
  occupancy: number;
}

const VERDICT_TEXT: Record<IncidentVerdict, string> = {
  "confirmed-real": "The network believes this road is blocked, and it is. A true positive.",
  "confirmed-false":
    "The network believes this road is blocked and nothing is there. A false positive — this is what an attacker's fabricated report looks like from the inside.",
  unreported:
    "Something is genuinely wrong here and the network has not confirmed it yet. Either nobody has driven past twice, or the reports have not been corroborated.",
  clear: "Nothing here, and the network agrees.",
};

/**
 * Everything known about one road, with belief and truth side by side.
 *
 * `reports` is the engine's own log of who said what — the dossier does not
 * reach into the corroboration engine's private state, because a panel that
 * could see more than the network can would be describing a different system
 * from the one being measured.
 */
export function incidentDossier(
  seg: Segment,
  grid: CityGrid,
  reports: { segmentId: string; senderId: string; pseudonym: string; tick: number; confidence: number }[],
  trust: TrustRegistry,
): IncidentDossier {
  const mine = reports.filter((r) => r.segmentId === seg.id);
  const witnesses: Witness[] = mine.map((r) => ({
    pseudonym: r.pseudonym || r.senderId,
    trust: Math.round(trust.score(r.senderId) * 100) / 100,
    tick: r.tick,
    confidence: r.confidence,
  }));
  const distinct = new Set(mine.map((r) => r.senderId)).size;

  const verdict: IncidentVerdict = seg.confirmedIncident
    ? seg.hazardActive
      ? "confirmed-real"
      : "confirmed-false"
    : seg.hazardActive
      ? "unreported"
      : "clear";

  const [causeCode, subCauseCode] = seg.hazardActive
    ? causeFor(seg.hazardType || "accident")
    : seg.confirmedIncident
      ? [CAUSE_CODE.DANGEROUS_SITUATION, 0]
      : [null, null];

  const firstReport = mine.length ? Math.min(...mine.map((r) => r.tick)) : null;

  return {
    segment_id: seg.id,
    road: roadName(seg.id),
    district: LAND_USE_LABEL[grid.landUse(seg.a)],
    ground_truth: seg.hazardActive,
    ground_truth_type: seg.hazardType,
    believed: seg.confirmedIncident,
    verdict,
    verdict_text: VERDICT_TEXT[verdict],
    cause_code: causeCode,
    sub_cause_code: subCauseCode,
    first_reported_tick: firstReport,
    confirmed_tick: seg.confirmedIncident ? seg.confirmedTick : null,
    latency_ticks:
      seg.confirmedIncident && seg.hazardStartedTick >= 0
        ? seg.confirmedTick - seg.hazardStartedTick
        : null,
    witnesses,
    distinct_witnesses: distinct,
    occupancy: Math.round(seg.occupancy * 100) / 100,
  };
}

/** "Cathedral Ave × 3rd Cross" for a junction, the road name for a segment. */
export function placeName(id: string): string {
  return id.includes("_") ? roadName(id) : junctionName(id);
}
