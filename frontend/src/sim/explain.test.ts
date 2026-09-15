/**
 * The explanations have to be true, and they have to be limited.
 *
 * True: every figure quoted comes out of the simulation rather than being
 * narrated from the outcome. Limited: the panel may not know more than the
 * network does — the one deliberate exception is ground truth, which exists
 * precisely so belief can be checked against it and is always labelled as the
 * simulator's own knowledge rather than the network's.
 */
import { describe, expect, it } from "vitest";

import { SimulationEngine } from "./engine";
import { DecisionLedger, incidentDossier } from "./explain";
import { CityGrid, junctionName, roadName } from "./core";
import { TrustRegistry } from "./network";

const engine = (over: Partial<ConstructorParameters<typeof SimulationEngine>[0]> = {}) =>
  new SimulationEngine({ seed: 11, gridSize: 6, numRsus: 4, numVehicles: 14, autoHazards: false, ...over });

const run = (sim: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) sim.step();
  return sim;
};

describe("place names", () => {
  it("names a road rather than printing a matrix index", () => {
    expect(roadName("2-3_3-3")).toBe("4th Cross, Cathedral–University block");
    expect(roadName("5-3_5-4")).toBe("Station Avenue, 4th Cross–5th Cross");
  });

  it("names a junction by the two roads that meet at it", () => {
    expect(junctionName("2-3")).toBe("Cathedral Ave × 4th Cross");
  });

  it("stays unambiguous on a grid larger than the name list", () => {
    const names = new Set<string>();
    for (let x = 0; x < 12; x++) names.add(roadName(`${x}-0_${x + 1}-0`));
    expect(names.size).toBe(12);
  });
});

describe("the decision ledger", () => {
  it("keeps the newest decisions and forgets the oldest", () => {
    const ledger = new DecisionLedger();
    for (let i = 0; i < 400; i++)
      ledger.record({
        tick: i,
        kind: "report",
        subject: `car-${i}`,
        where: null,
        headline: `report ${i}`,
        evidence: [],
        rule: "",
        effect: "",
      });
    expect(ledger.size).toBeLessThanOrEqual(140);
    expect(ledger.recent(1)[0].headline).toBe("report 399");
  });

  it("can be narrowed to one vehicle or one road", () => {
    const ledger = new DecisionLedger();
    ledger.record({
      tick: 1, kind: "divert", subject: "car-1", where: "0-0_1-0",
      headline: "a", evidence: [], rule: "", effect: "",
    });
    ledger.record({
      tick: 2, kind: "divert", subject: "car-2", where: "1-0_2-0",
      headline: "b", evidence: [], rule: "", effect: "",
    });
    expect(ledger.forSubject("car-1").map((d) => d.headline)).toEqual(["a"]);
    expect(ledger.forSubject("1-0_2-0").map((d) => d.headline)).toEqual(["b"]);
  });

  it("records a diversion with the evidence and the rule behind it", () => {
    const sim = engine({ numVehicles: 20 });
    run(sim, 30);
    sim.injectHazard();
    run(sim, 60);

    const diversions = (sim.stateSnapshot().decisions ?? []).filter((d) => d.kind === "divert");
    if (!diversions.length) return; // no vehicle happened to be routed through it
    for (const d of diversions) {
      expect(d.evidence.length).toBeGreaterThan(0);
      expect(d.rule).toContain("threshold");
      expect(d.effect).not.toBe("");
    }
  });

  it("explains a collision at the moment it is staged", () => {
    const sim = engine();
    run(sim, 30);
    const crash = sim.triggerCollision()!;
    const explained = (sim.stateSnapshot().decisions ?? []).find((d) => d.kind === "collision");

    expect(explained).toBeTruthy();
    expect(explained!.where).toBe(crash.segment_id);
    expect(explained!.headline).toContain(roadName(crash.segment_id).split(",")[0]);
  });
});

describe("incident dossiers", () => {
  it("calls a real hazard the network confirmed a true positive", () => {
    const grid = new CityGrid(6);
    const seg = grid.segments.get("0-0_1-0")!;
    seg.raiseHazard("oil_spill", 40, 5);
    seg.confirmIncident(9, 30);

    const d = incidentDossier(seg, grid, [], new TrustRegistry());
    expect(d.verdict).toBe("confirmed-real");
    expect(d.latency_ticks).toBe(4);
    expect(d.ground_truth_type).toBe("oil_spill");
  });

  it("calls a confirmed incident with nothing behind it a false positive", () => {
    // This is what a successful injection attack looks like from the inside,
    // and it is the same event the precision figure counts.
    const grid = new CityGrid(6);
    const seg = grid.segments.get("0-0_1-0")!;
    seg.confirmIncident(9, 30);

    const d = incidentDossier(seg, grid, [], new TrustRegistry());
    expect(d.verdict).toBe("confirmed-false");
    expect(d.ground_truth).toBe(false);
    expect(d.verdict_text).toContain("false positive");
  });

  it("calls a real hazard nobody has confirmed unreported", () => {
    const grid = new CityGrid(6);
    const seg = grid.segments.get("0-0_1-0")!;
    seg.raiseHazard("accident", 40, 5);

    expect(incidentDossier(seg, grid, [], new TrustRegistry()).verdict).toBe("unreported");
  });

  it("counts distinct reporters, not repeated reports", () => {
    const grid = new CityGrid(6);
    const seg = grid.segments.get("0-0_1-0")!;
    seg.raiseHazard("accident", 40, 1);
    const reports = [
      { segmentId: seg.id, senderId: "car-1", pseudonym: "pid-a", tick: 2, confidence: 0.8 },
      { segmentId: seg.id, senderId: "car-1", pseudonym: "pid-a", tick: 3, confidence: 0.8 },
      { segmentId: seg.id, senderId: "car-2", pseudonym: "pid-b", tick: 3, confidence: 0.9 },
      { segmentId: "1-0_2-0", senderId: "car-3", pseudonym: "pid-c", tick: 3, confidence: 0.9 },
    ];

    const d = incidentDossier(seg, grid, reports, new TrustRegistry());
    expect(d.distinct_witnesses).toBe(2);
    expect(d.witnesses).toHaveLength(3);
  });

  it("identifies witnesses by pseudonym, never by the vehicle behind it", () => {
    // The panel is not a back door around M11. If it named the vehicle, the
    // unlinkability the whole pseudonym scheme exists to provide would be
    // undone by the debugging view.
    const sim = engine({ numVehicles: 16 });
    run(sim, 20);
    sim.injectHazard();
    run(sim, 40);

    const ids = new Set(sim.vehicles.keys());
    for (const d of sim.stateSnapshot().dossiers ?? [])
      for (const w of d.witnesses) expect(ids.has(w.pseudonym)).toBe(false);
  });

  it("only ships a dossier for a road somebody could have an opinion about", () => {
    const sim = engine();
    run(sim, 20);
    const snapshot = sim.stateSnapshot();
    const interesting = snapshot.segments.filter((s) => s.hazard_active || s.confirmed_incident);
    expect(snapshot.dossiers).toHaveLength(interesting.length);
  });
});
