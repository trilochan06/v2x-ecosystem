/**
 * The driver's view.
 *
 * The property worth defending is that nothing in it is invented. Every alert
 * has to trace back to state the vehicle genuinely holds, which is why the
 * sharpest test here is the one that selects a bicycle: no receiver, so no
 * warnings, however much is going on around it.
 */
import { describe, expect, it } from "vitest";

import { SimulationEngine } from "./engine";

const run = (e: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) e.step();
  return e;
};

const city = (seed = 12, numVehicles = 24) =>
  new SimulationEngine({ seed, gridSize: 5, numRsus: 6, numVehicles, autoHazards: false });

describe("the driver's view", () => {
  it("is null for a vehicle that is not there", () => {
    expect(city().pov("nobody-99")).toBeNull();
  });

  it("reports the speed the vehicle is actually doing, not its top speed", () => {
    const e = city();
    run(e, 30);
    for (const v of e.vehicles.values()) {
      const pov = e.pov(v.id)!;
      expect(pov.speedKmh).toBe(Math.round(v.lastSpeedKmh));
      // Congestion, hazards and GLOSA can only hold a vehicle back.
      expect(pov.speedKmh).toBeLessThanOrEqual(Math.ceil(v.profile.speedKmh));
    }
  });

  it("names the road, the destination and the way there", () => {
    const e = city();
    run(e, 20);
    const driving = [...e.vehicles.values()].find((v) => v.currentSegmentId && v.route.length > 2)!;
    const pov = e.pov(driving.id)!;

    expect(pov.road).not.toBe("—");
    expect(pov.destination.length).toBeGreaterThan(0);
    expect(pov.distanceToDestinationM).toBeGreaterThan(0);
    for (const step of pov.steps) {
      expect(["Turn left", "Turn right", "Continue straight", "Turn around"]).toContain(
        step.instruction,
      );
      expect(step.distanceM).toBeGreaterThanOrEqual(0);
    }
    // Turns are listed in the order they are reached.
    const distances = pov.steps.map((s) => s.distanceM);
    expect([...distances].sort((a, b) => a - b)).toEqual(distances);
  });

  it("sorts alerts so the critical ones are read first", () => {
    const e = city();
    run(e, 40);
    e.triggerCollision();
    run(e, 6);
    for (const v of e.vehicles.values()) {
      const order = e.pov(v.id)!.alerts.map((a) => a.priority);
      const rank = { critical: 0, warning: 1, info: 2 } as const;
      const ranks = order.map((p) => rank[p]);
      expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    }
  });

  it("gives an unequipped road user no warnings at all", () => {
    const e = new SimulationEngine({
      seed: 3,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 0,
      autoHazards: false,
    });
    const bike = e.spawnVehicle("bicycle");
    // Fill the road around it with things that would alarm a connected car.
    for (let i = 0; i < 4; i++) e.spawnVehicle("car", bike.node);
    e.spawnVehicle("ambulance", bike.node);
    run(e, 25);
    e.injectHazard();
    run(e, 10);

    const pov = e.pov(bike.id)!;
    expect(pov.equipped).toBe(false);
    expect(pov.alerts).toEqual([]);
    // It still has a speed, a road and a destination — it is a road user, not
    // an absence. It simply cannot be told anything.
    expect(pov.road).not.toBe("—");
    expect(pov.destination.length).toBeGreaterThan(0);
  });

  it("gives a connected car in the same place something to say", () => {
    const e = new SimulationEngine({
      seed: 3,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 0,
      autoHazards: false,
    });
    const car = e.spawnVehicle("car");
    for (let i = 0; i < 4; i++) e.spawnVehicle("car", car.node);
    e.spawnVehicle("bicycle", car.node);
    run(e, 25);

    // Not asserting a particular alert — which ones fire depends on where the
    // traffic went. The point is that an equipped vehicle is reachable at all,
    // which is the contrast the previous test sets up.
    const pov = e.pov(car.id)!;
    expect(pov.equipped).toBe(true);
    expect(pov.neighbours.length).toBeGreaterThan(0);
  });

  it("marks an emergency vehicle as running on priority", () => {
    const e = city();
    const amb = e.spawnVehicle("ambulance");
    run(e, 5);
    const kinds = e.pov(amb.id)!.alerts.map((a) => a.kind);
    expect(kinds).toContain("priority_run");
  });

  it("tells a yielding vehicle why it is yielding", () => {
    const e = city();
    run(e, 20);
    const anywhere = [...e.vehicles.values()][0]?.node;
    if (anywhere) e.dispatchAmbulanceTo(anywhere);
    run(e, 25);
    const yielding = [...e.vehicles.values()].find((v) => v.yieldInstruction);
    if (!yielding) return; // no corridor crossed anyone this run
    const alert = e.pov(yielding.id)!.alerts.find((a) => a.kind === "emergency_vehicle");
    expect(alert?.priority).toBe("critical");
  });

  it("describes neighbours by where they are, not by bearing", () => {
    const e = city();
    run(e, 30);
    for (const v of e.vehicles.values()) {
      for (const n of e.pov(v.id)!.neighbours) {
        expect(["ahead", "behind", "at the junction", "crossing"]).toContain(n.relation);
        expect(n.id).not.toBe(v.id);
        expect(n.distanceM).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("never reports a speed over the limit without saying so", () => {
    const e = city();
    run(e, 60);
    for (const v of e.vehicles.values()) {
      const pov = e.pov(v.id)!;
      if (pov.equipped && pov.speedKmh > pov.speedLimitKmh + 1) {
        expect(pov.alerts.some((a) => a.kind === "speed_limit")).toBe(true);
      }
    }
  });

  it("reads the simulation without changing it", () => {
    const a = city();
    run(a, 40);
    const before = JSON.stringify(a.stateSnapshot());
    for (const v of a.vehicles.values()) a.pov(v.id);
    expect(JSON.stringify(a.stateSnapshot())).toBe(before);
  });
});
