/**
 * The twin's what-if.
 *
 * The properties that matter are that it predicts the right *direction*, that
 * it never touches the live city until asked, and that it is measured against
 * a baseline rather than against nothing. Exact magnitudes are the shipped
 * congestion model's business, and asserting them here would be asserting the
 * model's weights.
 */
import { describe, expect, it } from "vitest";

import { SimulationEngine } from "./engine";
import { INTERVENTION_LABEL } from "./whatif";

const run = (e: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) e.step();
  return e;
};

const city = (seed = 21, numVehicles = 30) =>
  new SimulationEngine({ seed, gridSize: 5, numRsus: 6, numVehicles, autoHazards: false });

const busiest = (e: SimulationEngine) =>
  [...e.stateSnapshot().segments].sort((a, b) => b.occupancy - a.occupancy)[0].id;


describe("what-if on the twin", () => {
  it("changes nothing in the live city", () => {
    const e = city();
    run(e, 60);
    const before = JSON.stringify(e.stateSnapshot());
    e.whatIf({ kind: "close_road", segmentId: busiest(e) });
    e.whatIf({ kind: "rain" });
    e.whatIf({ kind: "accident", segmentId: busiest(e) });
    expect(JSON.stringify(e.stateSnapshot())).toBe(before);
  });

  it("measures against a baseline forecast, not against zero", () => {
    const e = city();
    run(e, 60);
    const r = e.whatIf({ kind: "rain" });
    expect(r.baselineMeanOccupancy).toBeGreaterThan(0);
    expect(r.deltaMeanOccupancy).toBeCloseTo(
      r.predictedMeanOccupancy - r.baselineMeanOccupancy,
      3,
    );
  });

  it("expects rain to put the city under more pressure, and fog more than rain", () => {
    const e = city();
    run(e, 60);
    const rain = e.whatIf({ kind: "rain" });
    const fog = e.whatIf({ kind: "fog" });
    expect(rain.deltaMeanOccupancy).toBeGreaterThan(0);
    expect(fog.deltaMeanOccupancy).toBeGreaterThanOrEqual(rain.deltaMeanOccupancy);
  });

  it("empties a closed road and pushes its traffic onto what meets it", () => {
    const e = city();
    run(e, 70);
    const target = busiest(e);
    const r = e.whatIf({ kind: "close_road", segmentId: target });

    const closed = r.roads.find((road) => road.segmentId === target);
    if (closed) expect(closed.delta).toBeLessThan(0);
    // Something nearby has to take it. A closure that lightens the whole city
    // would mean the traffic had been deleted rather than displaced.
    expect(r.roads.some((road) => road.segmentId !== target && road.delta > 0)).toBe(true);
  });

  it("reports the peak as well as the mean, because a closure moves them apart", () => {
    const e = city();
    run(e, 70);
    const r = e.whatIf({ kind: "close_road", segmentId: busiest(e) });
    // Both have to be present: a closure spreads one road's traffic over the
    // roads meeting it, which can pull the average down while pushing a
    // junction up, and reporting only the mean would call that an improvement.
    expect(r.baselineWorst).toBeGreaterThan(0);
    expect(r.predictedWorst).toBeGreaterThan(0);
    expect(r.baselineWorst).toBeGreaterThanOrEqual(r.baselineMeanOccupancy);
  });

  it("shows the traffic arriving somewhere, not vanishing", () => {
    const e = city();
    run(e, 70);
    const target = busiest(e);
    const r = e.whatIf({ kind: "close_road", segmentId: target });
    const gained = r.roads.filter((road) => road.segmentId !== target && road.delta > 0);
    // Displaced traffic divides across the roads that meet the closed one, so
    // each share is small; the forecast still has to show it landing.
    expect(gained.length).toBeGreaterThan(0);
  });

  it("treats an accident as a blockage, not a closure", () => {
    const e = city();
    run(e, 70);
    const target = busiest(e);
    const closure = e.whatIf({ kind: "close_road", segmentId: target });
    const crash = e.whatIf({ kind: "accident", segmentId: target });

    const on = (r: typeof closure, id: string) => r.roads.find((x) => x.segmentId === id)?.after ?? 0;
    // A crash leaves traffic sitting on the road; a closure does not.
    expect(on(crash, target)).toBeGreaterThanOrEqual(on(closure, target));
  });

  it("reports how far the replica had drifted when it forecast", () => {
    const e = city();
    run(e, 60);
    const r = e.whatIf({ kind: "rain" });
    expect(r.confidence.divergenceAtForecast).toBeGreaterThanOrEqual(0);
    expect(r.confidence.stalenessTicks).toBeGreaterThanOrEqual(0);
    expect(r.confidence.note.length).toBeGreaterThan(0);
  });

  it("names the intervention in words a viewer can read", () => {
    expect(INTERVENTION_LABEL({ kind: "rain" })).toMatch(/rain/i);
    expect(INTERVENTION_LABEL({ kind: "fog" })).toMatch(/fog/i);
    const e = city();
    expect(
      INTERVENTION_LABEL({ kind: "close_road", segmentId: e.stateSnapshot().segments[0].id }),
    ).toMatch(/close/i);
  });

  it("only moves the city when the intervention is applied", () => {
    const e = city();
    run(e, 60);
    const target = busiest(e);

    e.whatIf({ kind: "accident", segmentId: target });
    expect(e.grid.segments.get(target)!.hazardActive).toBe(false);

    expect(e.applyIntervention({ kind: "accident", segmentId: target })).toBe(true);
    expect(e.grid.segments.get(target)!.hazardActive).toBe(true);
  });

  it("applies weather to the whole city, as weather works", () => {
    const e = city();
    run(e, 30);
    e.applyIntervention({ kind: "rain" });
    const wet = e.stateSnapshot().segments.filter((s) => s.hazard_active);
    expect(wet.length).toBe(e.stateSnapshot().segments.length);
  });
});

describe("the twin's anomalies", () => {
  /** A city with nobody in it. No vehicles means no reports, so nothing is
   *  ever corroborated and a real hazard stays unknown to the network — which
   *  is the one condition under which the twin is the only thing that can
   *  tell. In a busy city every road is witnessed within a tick or two. */
  const deserted = () =>
    new SimulationEngine({
      seed: 21,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 0,
      autoHazards: false,
    });

  it("notices a real hazard that nobody witnessed", () => {
    const e = deserted();
    run(e, 10);
    const target = e.stateSnapshot().segments[0].id;
    e.grid.segments.get(target)!.raiseHazard("accident", 500, e.tick);
    run(e, 8);

    const seg = e.grid.segments.get(target)!;
    // Precondition: the network really is blind to it.
    expect(seg.hazardActive).toBe(true);
    expect(seg.confirmedIncident).toBe(false);

    const kinds = e.twin.anomalies.filter((a) => a.segmentId === target).map((a) => a.kind);
    expect(kinds).toContain("unmodelled_incident");
  });

  it("reports one hazard once, however long it lasts", () => {
    const e = deserted();
    run(e, 10);
    const target = e.stateSnapshot().segments[0].id;
    e.grid.segments.get(target)!.raiseHazard("accident", 500, e.tick);
    run(e, 40);
    const forTarget = e.twin.anomalies.filter(
      (a) => a.segmentId === target && a.kind === "unmodelled_incident",
    );
    expect(forTarget.length).toBe(1);
  });

  it("notices a confirmation with nothing behind it", () => {
    const e = deserted();
    run(e, 10);
    const target = e.stateSnapshot().segments[0].id;
    // The network became convinced on its own: no raiseHazard, so there is
    // nothing physically on this road. That is what a successful injection
    // looks like from outside.
    e.grid.segments.get(target)!.confirmIncident(e.tick, 200);
    run(e, 8);
    const kinds = e.twin.anomalies.filter((a) => a.segmentId === target).map((a) => a.kind);
    expect(kinds).toContain("phantom_incident");
  });

  it("stays quiet in a city where belief and reality agree", () => {
    const e = deserted();
    run(e, 30);
    expect(e.twin.anomalies).toEqual([]);
  });
});
