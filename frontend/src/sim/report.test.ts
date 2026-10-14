/**
 * The run report.
 *
 * Its one job is to agree with the screen it was taken from, so the tests
 * check that its figures come from state rather than being recomputed, and
 * that the sentence it writes about belief against reality says the right
 * thing in each of the three cases that can occur.
 */
import { describe, expect, it } from "vitest";

import { SimulationEngine } from "./engine";
import { buildReport, reportFilename } from "./report";

const run = (e: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) e.step();
  return e;
};

const city = (seed = 44, ticks = 200) =>
  run(
    new SimulationEngine({ seed, gridSize: 5, numRsus: 6, numVehicles: 28, autoHazards: true }),
    ticks,
  );

describe("the run report", () => {
  it("quotes the figures that are on screen", () => {
    const e = city();
    const state = e.stateSnapshot();
    const md = buildReport(state, null);

    expect(md).toContain(`tick ${state.tick}`);
    expect(md).toContain(state.config.label);
    expect(md).toContain(String(state.vehicles.length));
    expect(md).toContain(state.federated.current_loss.toFixed(6));
    expect(md).toContain(state.federated.centralized_loss.toFixed(6));
    expect(md).toContain(String(state.digital_twin.syncs));
  });

  it("breaks the fleet down by kind, with the car-equivalents", () => {
    const e = city();
    const state = e.stateSnapshot();
    const md = buildReport(state, null);
    const kinds = new Set(state.vehicles.map((v) => v.kind));
    // Every kind actually on the road is named.
    if (kinds.has("bicycle")) {
      expect(md).toContain("Bicycle");
      expect(md).toContain("no on-board unit");
    }
    if (kinds.has("bus")) expect(md).toContain("Bus");
    expect(md).toContain("Car-equivalents each");
  });

  it("says plainly where belief and reality part company", () => {
    const e = new SimulationEngine({
      seed: 2,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 0,
      autoHazards: false,
    });
    run(e, 10);

    // Nothing anywhere: the two agree.
    expect(buildReport(e.stateSnapshot(), null)).toContain("agree at this instant");

    // A real hazard with nobody to witness it: the network is blind.
    const target = e.stateSnapshot().segments[0].id;
    e.grid.segments.get(target)!.raiseHazard("accident", 300, e.tick);
    run(e, 3);
    expect(buildReport(e.stateSnapshot(), null)).toMatch(/blind to 1 real hazard/);

    // A confirmation with nothing behind it: the network is wrong the other way.
    e.grid.segments.get(target)!.clearHazard();
    e.grid.segments.get(target)!.confirmIncident(e.tick, 300);
    run(e, 3);
    expect(buildReport(e.stateSnapshot(), null)).toMatch(/believes 1 hazard\(s\) that are not/);
  });

  it("includes the selected vehicle and its alerts when there is one", () => {
    const e = city();
    const state = e.stateSnapshot();
    const vehicle = state.vehicles[0];
    const pov = e.pov(vehicle.id)!;
    const md = buildReport(state, pov);

    expect(md).toContain("## Selected vehicle");
    expect(md).toContain(pov.vehicleId);
    if (!pov.equipped) expect(md).toContain("receives nothing");
  });

  it("leaves the vehicle section out when nothing is selected", () => {
    const md = buildReport(city().stateSnapshot(), null);
    expect(md).not.toContain("## Selected vehicle");
  });

  it("escapes a pipe so a detail cannot break the table", () => {
    const e = city();
    const state = e.stateSnapshot();
    const pov = e.pov(state.vehicles[0].id)!;
    const md = buildReport(state, {
      ...pov,
      equipped: true,
      alerts: [
        {
          id: "x",
          kind: "test",
          priority: "warning",
          title: "Pipe",
          detail: "a | b | c",
        },
      ],
    });
    expect(md).toContain("a \\| b \\| c");
  });

  it("names the file so a folder of them sorts by tick", () => {
    const a = reportFilename({ tick: 7 } as never);
    const b = reportFilename({ tick: 1200 } as never);
    expect(a < b).toBe(true);
    expect(a.endsWith(".md")).toBe(true);
  });
});
