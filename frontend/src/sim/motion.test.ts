/**
 * Vehicle motion — the part of the simulation an audience watches directly.
 *
 * Every other suite here checks a number. These check that the picture is not
 * lying: that a car goes where a car can go, that it does not cross the city
 * between two frames, and that a wreck stays wrecked. A metric can be right
 * while the map is nonsense, and the map is what a viva audience sees.
 */
import { describe, expect, it } from "vitest";

import { SimulationEngine } from "./engine";

const engine = (over: Partial<ConstructorParameters<typeof SimulationEngine>[0]> = {}) =>
  new SimulationEngine({ seed: 7, gridSize: 6, numRsus: 4, numVehicles: 14, ...over });

/** Distance in grid units between two positions. */
const dist = (a: { x: number; y: number }, b: { x: number; y: number }) =>
  Math.hypot(a.x - b.x, a.y - b.y);

/**
 * The furthest anything may legitimately move in one tick.
 *
 * A segment is 250 m and the fastest vehicle is an ambulance; even at its top
 * speed that is a fraction of one grid unit per tick. One whole unit means the
 * vehicle changed which road it was on without driving along it.
 */
const MAX_STEP = 1.0;

describe("vehicles move continuously", () => {
  it("never jumps further in one tick than it could have driven", () => {
    const sim = engine();
    let previous = new Map(sim.stateSnapshot().vehicles.map((v) => [v.id, v]));

    const jumps: string[] = [];
    for (let t = 0; t < 400; t++) {
      sim.step();
      const now = new Map(sim.stateSnapshot().vehicles.map((v) => [v.id, v]));
      for (const [id, v] of now) {
        const was = previous.get(id);
        // A vehicle that has only just entered the city has no previous
        // position to be continuous with.
        if (!was) continue;
        const moved = dist(was, v);
        if (moved > MAX_STEP) jumps.push(`${id} moved ${moved.toFixed(2)} units at tick ${sim.tick}`);
      }
      previous = now;
    }

    expect(jumps).toEqual([]);
  });

  it("is always on a road that exists, between the two junctions it joins", () => {
    const sim = engine();
    const offRoad: string[] = [];

    for (let t = 0; t < 300; t++) {
      sim.step();
      for (const v of sim.stateSnapshot().vehicles) {
        if (!v.next_node) continue;
        const seg = sim.grid.segments.get(`${v.node}_${v.next_node}`) ??
          sim.grid.segments.get(`${v.next_node}_${v.node}`);
        if (!seg) {
          offRoad.push(`${v.id} is driving ${v.node} → ${v.next_node}, which is not a road`);
          continue;
        }
        const [ax, ay] = sim.grid.coords(v.node);
        const [bx, by] = sim.grid.coords(v.next_node);
        const along = dist({ x: ax, y: ay }, v) + dist(v, { x: bx, y: by });
        const span = dist({ x: ax, y: ay }, { x: bx, y: by });
        if (along > span + 1e-6)
          offRoad.push(`${v.id} is off the line between ${v.node} and ${v.next_node}`);
      }
    }

    expect(offRoad).toEqual([]);
  });

  it("finishes the road it is on before taking a different one", () => {
    // This is the rule that makes the two tests above hold. A vehicle may
    // change its mind about the rest of the route at any time; it may not
    // change its mind about the link it is halfway down.
    const sim = engine();
    const committed = new Map<string, { segment: string; progress: number }>();
    const broken: string[] = [];

    for (let t = 0; t < 400; t++) {
      sim.step();
      for (const v of sim.vehicles.values()) {
        const seg = v.currentSegmentId;
        const was = committed.get(v.id);
        if (was && seg && seg !== was.segment && was.progress > 0 && v.progress > 0)
          broken.push(`${v.id} abandoned ${was.segment} at ${was.progress.toFixed(2)} for ${seg}`);
        if (seg) committed.set(v.id, { segment: seg, progress: v.progress });
        else committed.delete(v.id);
      }
    }

    expect(broken).toEqual([]);
  });
});

describe("rerouting", () => {
  it("keeps the vehicle on its current link and reroutes from the junction ahead", () => {
    const sim = engine();
    for (let t = 0; t < 40; t++) sim.step();

    const vehicle = [...sim.vehicles.values()].find((v) => v.route.length >= 4 && v.progress > 0.1);
    expect(vehicle, "no vehicle was mid-link with a route to divert").toBeTruthy();

    const before = { node: vehicle!.node, next: vehicle!.nextNode, progress: vehicle!.progress };
    // Warn it about the road immediately after the one it is on, which is the
    // first road it can still do anything about.
    const ahead = sim.grid.segmentBetween(vehicle!.route[1], vehicle!.route[2]);
    vehicle!.hazardWarnings.set(ahead.id, sim.tick);
    vehicle!.reroute(sim.tick);

    expect(vehicle!.node).toBe(before.node);
    expect(vehicle!.nextNode).toBe(before.next);
    expect(vehicle!.progress).toBe(before.progress);
  });
});

describe("a crash is permanent", () => {
  it("removes the wreck from the city instead of letting it drive away", () => {
    const sim = engine();
    for (let t = 0; t < 30; t++) sim.step();

    const crash = sim.triggerCollision();
    expect(crash).toBeTruthy();
    const [a, b] = crash!.vehicles;
    expect(sim.vehicles.get(a)!.crashed).toBe(true);

    // Long enough for recovery to have been and gone.
    for (let t = 0; t < 60; t++) sim.step();

    for (const id of [a, b].filter(Boolean)) {
      const still = sim.vehicles.get(id);
      expect(still, `${id} was in a collision and is still driving around`).toBeUndefined();
    }
  });

  it("only ever crashes vehicles that were already where they are", () => {
    // Staging a collision used to spawn a car and place it on the victim's
    // segment, which is a teleport in full view of the audience. Whichever of
    // the three kinds fires, nothing may appear, vanish or move.
    for (const numVehicles of [1, 4, 16]) {
      const sim = engine({ numVehicles });
      for (let t = 0; t < 12; t++) sim.step();

      const before = new Map([...sim.vehicles.values()].map((v) => [v.id, v.positionXY()]));
      const crash = sim.triggerCollision();
      expect(crash).toBeTruthy();
      expect(["shunt", "junction", "solo"]).toContain(crash!.kind);
      expect([...sim.vehicles.keys()].sort()).toEqual([...before.keys()].sort());

      for (const [id, [x, y]] of before) {
        const [nx, ny] = sim.vehicles.get(id)!.positionXY();
        expect(Math.hypot(nx - x, ny - y), `${id} was moved`).toBeLessThan(1e-9);
      }
    }
  });

  it("calls a lone vehicle's accident what it is", () => {
    const sim = engine({ numVehicles: 1 });
    for (let t = 0; t < 20; t++) sim.step();
    const crash = sim.triggerCollision()!;
    expect(crash.kind).toBe("solo");
    expect(crash.vehicles).toHaveLength(1);
  });

  it("keeps the lane blocked for as long as the wreck is in it", () => {
    const sim = engine();
    for (let t = 0; t < 30; t++) sim.step();
    const crash = sim.triggerCollision();
    expect(crash).toBeTruthy();

    const seg = sim.grid.segments.get(crash!.segment_id)!;
    expect(seg.hazardActive).toBe(true);
    expect(seg.hazardType).toBe("accident");
  });
});

describe("trips have a purpose", () => {
  it("sends more people to the centre than to the outskirts", () => {
    // A random walk is not traffic. Destinations are drawn in proportion to
    // what a place is for, which is what makes a jam form in the middle of
    // the map on its own rather than only when the injector puts one there.
    const sim = engine({ numVehicles: 24 });
    const chosen: string[] = [];
    const seen = new Map<string, string>();

    for (let t = 0; t < 900; t++) {
      sim.step();
      for (const v of sim.vehicles.values()) {
        if (seen.get(v.id) !== v.destination) chosen.push(v.destination);
        seen.set(v.id, v.destination);
      }
    }

    // Trips are long — a crossing of a six-by-six grid is most of two hundred
    // ticks — so this is a few trips each, not a few hundred.
    expect(chosen.length).toBeGreaterThan(50);
    const share = (use: string) =>
      chosen.filter((n) => sim.grid.landUse(n) === use).length / chosen.length;

    const centreNodes = [...sim.grid.nodes.keys()].filter((n) => sim.grid.landUse(n) === "centre");
    const perCentreNode = share("centre") / centreNodes.length;
    const residential = [...sim.grid.nodes.keys()].filter(
      (n) => sim.grid.landUse(n) === "residential",
    );
    const perResidentialNode = share("residential") / residential.length;

    expect(perCentreNode).toBeGreaterThan(perResidentialNode * 2);
  });

  it("parks on arrival instead of bouncing off its own destination", () => {
    const sim = engine();
    let everParked = false;
    for (let t = 0; t < 400; t++) {
      sim.step();
      if ([...sim.vehicles.values()].some((v) => v.dwellTicks > 0)) everParked = true;
    }
    expect(everParked).toBe(true);
  });

  it("says why each vehicle is driving where it is", () => {
    const sim = engine();
    for (let t = 0; t < 20; t++) sim.step();
    for (const v of sim.stateSnapshot().vehicles) expect(v.trip_purpose).toBeTruthy();
  });
});
