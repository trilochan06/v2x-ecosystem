/**
 * The three prototype applications described by Porsche Engineering, as they
 * behave in the browser engine.
 *
 * 1. Emergency brake warning — a car brakes hard and the traffic behind is
 *    told before its drivers could possibly see why.
 * 2. Collective perception — a car turning into a crossing is warned about a
 *    pedestrian it has no line of sight to, because another car can see them.
 * 3. Traffic-light interaction — a vehicle uses the phase an intersection is
 *    already broadcasting to arrive on green instead of braking at a red.
 *
 * This mirrors `backend/tests/test_porsche_use_cases.py` case for case. The
 * two engines are separate implementations of the same model, so a behaviour
 * that only holds on one side is a bug on the other.
 */
import { describe, expect, it } from "vitest";

import { CAUSE_CODE, MESSAGE_SPECS, causeFor } from "./core";
import { TrafficLight } from "./agents";
import { SimulationEngine } from "./engine";

const scene = (seed = 4, numVehicles = 8) =>
  new SimulationEngine({ seed, gridSize: 4, numRsus: 4, numVehicles, autoHazards: false });

const run = (engine: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) engine.step();
  return engine;
};

// ----------------------------------------------- 1. emergency brake light
describe("emergency electronic brake light", () => {
  it("encodes as the standard cause code", () => {
    // DENM causeCode 99, subCauseCode 1 is emergencyElectronicBrakeEngaged.
    expect(causeFor("hard_braking")).toEqual([CAUSE_CODE.DANGEROUS_SITUATION, 1]);
  });

  it("makes a vehicle brake when a pedestrian is in its path", () => {
    const engine = run(scene(), 5);
    engine.spawnPedestrian();
    run(engine, 3);

    const crossing = [...engine.pedestrians.values()][0]?.segmentId;
    const onCrossing = [...engine.vehicles.values()].filter((v) => v.currentSegmentId === crossing);
    if (onCrossing.length) expect(onCrossing.some((v) => v.brakingTicks > 0)).toBe(true);
  });

  it("broadcasts a DENM and warns the traffic behind", () => {
    const engine = run(scene(), 6);
    engine.spawnPedestrian();
    run(engine, 12);

    const frames = engine.metrics.summary().communication.frames_by_designator;
    expect(frames.DENM ?? 0).toBeGreaterThan(0);
    expect(engine.perceptionStats.brakeWarnings).toBeGreaterThan(0);
  });

  it("does not let an attacker fake one", () => {
    // EEBL is trusted implicitly by whoever receives it, so a liar must not
    // be able to emit one.
    const engine = scene();
    const attacker = engine.spawnVehicle("malicious");
    attacker.brakingTicks = 3;
    expect(attacker.maybeReportBraking(engine.grid.allSegments()[0], engine.tick)).toBeNull();
  });
});

// ------------------------------------------- 2. collective perception (CPM)
describe("collective perception", () => {
  it("is a standard frame", () => {
    expect(MESSAGE_SPECS.cpm.designator).toBe("CPM");
    expect(MESSAGE_SPECS.cpm.standard).toBe("ETSI TS 103 324");
  });

  it("shares what a vehicle's sensors see", () => {
    const engine = run(scene(), 6);
    engine.spawnPedestrian();
    run(engine, 12);

    const frames = engine.metrics.summary().communication.frames_by_designator;
    expect(frames.CPM ?? 0).toBeGreaterThan(0);
    expect(engine.perceptionStats.shared).toBeGreaterThan(0);
  });

  it("limits line of sight to the crossing itself", () => {
    // A vehicle approaching the same junction down a different street is
    // turning blind — that asymmetry is the entire reason CPM exists.
    const engine = run(scene(), 4);
    const pid = engine.spawnPedestrian()!;
    const ped = engine.pedestrians.get(pid)!;

    for (const vehicle of engine.vehicles.values())
      expect(engine.hasLineOfSight(vehicle, ped)).toBe(vehicle.currentSegmentId === ped.segmentId);
  });

  it("still slows a blind vehicle once a peer tells it", () => {
    // The turning case: no sight of the pedestrian, but it brakes anyway.
    const engine = run(scene(), 4);
    const vehicle = [...engine.vehicles.values()][0];
    const segment = vehicle.currentSegmentId!;
    expect(segment).toBeTruthy();

    expect(vehicle.knowsPedestrianOn(segment, engine.tick)).toBe(false);
    vehicle.receivePerceivedObject(segment, engine.tick);

    expect(vehicle.knowsPedestrianOn(segment, engine.tick)).toBe(true);
    expect(vehicle.pedestrianKnownOnlyFromPeers(segment, engine.tick)).toBe(true);
  });

  it("does not count a vehicle's own sighting as a peer warning", () => {
    const engine = run(scene(), 4);
    const vehicle = [...engine.vehicles.values()][0];
    const segment = vehicle.currentSegmentId!;

    vehicle.seenPedestrians.set(segment, engine.tick);
    vehicle.receivePerceivedObject(segment, engine.tick);

    expect(vehicle.knowsPedestrianOn(segment, engine.tick)).toBe(true);
    // It could see them, so this is not a case collective perception saved.
    expect(vehicle.pedestrianKnownOnlyFromPeers(segment, engine.tick)).toBe(false);
  });

  it("grows the frame with the number of objects reported", () => {
    // Collective perception is a bandwidth trade, not a free win.
    const engine = run(scene(), 4);
    const vehicle = [...engine.vehicles.values()][0];

    vehicle.seenPedestrians = new Map([["0-0_1-0", engine.tick]]);
    const one = vehicle.maybeSharePerception(engine.tick);

    vehicle.seenPedestrians = new Map([
      ["0-0_1-0", engine.tick],
      ["0-0_0-1", engine.tick],
    ]);
    const two = vehicle.maybeSharePerception(engine.tick);

    expect(one).not.toBeNull();
    expect(two).not.toBeNull();
    expect(two!.variableBytes).toBeGreaterThan(one!.variableBytes);
  });

  it("does not let an attacker invent road users", () => {
    const engine = scene();
    const attacker = engine.spawnVehicle("malicious");
    attacker.seenPedestrians = new Map([["0-0_1-0", engine.tick]]);
    expect(attacker.maybeSharePerception(engine.tick)).toBeNull();
  });
});

// --------------------------------------------------------- 3. traffic lights
describe("traffic light interaction", () => {
  it("does not change every junction at once", () => {
    // Regression: every light in the city shared one formula with no offset,
    // so the whole grid turned red at the same instant.
    const lights: TrafficLight[] = [];
    for (let x = 0; x < 3; x++)
      for (let y = 0; y < 3; y++) lights.push(new TrafficLight(`light-${x}-${y}`, `${x}-${y}`));

    const seen = new Set<string>();
    for (let tick = 0; tick < 48; tick++) {
      for (const light of lights) light.step(tick);
      seen.add(lights.map((l) => l.phase).join(","));
    }
    // If they moved in lockstep there would be exactly two states.
    expect(seen.size).toBeGreaterThan(2);
  });

  it("actually hands vehicles the phase they are driving towards", () => {
    // Regression: SPaT was transmitted but never handed to receivers, so no
    // vehicle ever knew a phase and the advisory could not fire.
    const engine = run(scene(), 40);
    expect([...engine.vehicles.values()].some((v) => v.knownSignals.size > 0)).toBe(true);
  });

  it("issues an advisory speed on approach to a red", () => {
    const engine = run(scene(11), 200);
    expect(engine.stateSnapshot().perception.glosa_active).toBeGreaterThanOrEqual(0);

    let issued = 0;
    for (let i = 0; i < 200; i++) {
      engine.step();
      issued += [...engine.vehicles.values()].filter((v) => v.glosaAdvice !== null).length;
    }
    expect(issued).toBeGreaterThan(0);
  });

  it("never advises a speed faster than carrying on", () => {
    // Advising a *faster* speed at a red light would be actively dangerous.
    const engine = run(scene(11), 120);
    for (const vehicle of engine.vehicles.values())
      if (vehicle.glosaAdvice !== null) expect(vehicle.glosaAdvice).toBeLessThanOrEqual(vehicle.speedKmh);
  });

  it("does not act on a stale phase", () => {
    // A light heard about long ago may well have changed since.
    const engine = run(scene(), 4);
    const vehicle = [...engine.vehicles.values()][0];
    const nxt = vehicle.nextNode!;

    vehicle.receiveSignalPhase(nxt, "red", 0);
    vehicle.progress = 0.9;
    expect(vehicle.glosaAdviceFor(nxt, 500, 40)).toBeNull();
  });

  it("gives no advice when the light is already green", () => {
    const engine = run(scene(), 4);
    const vehicle = [...engine.vehicles.values()][0];
    const nxt = vehicle.nextNode!;

    vehicle.receiveSignalPhase(nxt, "green", engine.tick);
    vehicle.progress = 0.9;
    expect(vehicle.glosaAdviceFor(nxt, engine.tick, 40)).toBeNull();
  });
});

// ---------------------------------------------------------- collisions
describe("collisions", () => {
  const city = (seed = 4, numVehicles = 8) =>
    new SimulationEngine({ seed, gridSize: 4, numRsus: 9, numVehicles, autoHazards: false });

  it("immobilises both vehicles and blocks the lane", () => {
    const e = run(city(), 10);
    const info = e.triggerCollision()!;
    expect(info).not.toBeNull();

    const [first, second] = info.vehicles.map((id) => e.vehicles.get(id)!);
    expect(first.crashed).toBe(true);
    expect(second.crashed).toBe(true);
    expect(e.grid.segments.get(info.segment_id)!.hazardActive).toBe(true);

    const before = first.positionXY();
    run(e, 5);
    // A wreck does not drive away from its own accident.
    expect(first.positionXY()).toEqual(before);
  });

  it("announces itself and the network confirms it", () => {
    const e = run(city(), 10);
    const info = e.triggerCollision()!;
    run(e, 30);

    const seg = e.stateSnapshot().segments.find((s) => s.id === info.segment_id)!;
    expect(seg.confirmed_incident).toBe(true);
    expect(e.metrics.summary().communication.frames_by_designator.DENM ?? 0).toBeGreaterThan(0);
  });

  it("recovers the wreck rather than letting it drive away", () => {
    const e = run(city(), 10);
    const info = e.triggerCollision()!;
    run(e, 40);
    // Gone from the city entirely. Previously it sat still for twenty-two
    // ticks and then resumed its journey, which is not something a wrecked
    // car does.
    for (const id of info.vehicles) expect(e.vehicles.get(id)).toBeUndefined();
    expect([...e.vehicles.values()].some((v) => v.crashed)).toBe(false);
  });

  it("calls it a single-vehicle accident rather than conjuring a second car", () => {
    const e = run(city(4, 1), 6);
    const info = e.triggerCollision()!;
    // One vehicle in the city, so there is nothing for it to hit. Materialising
    // a second car on top of it would be a teleport in front of the audience;
    // a car leaving the carriageway is an accident that needs no second party.
    expect(info.solo).toBe(true);
    expect(info.vehicles).toHaveLength(1);
    expect(e.vehicles.size).toBe(1);
  });

  it("dispatches an ambulance towards the incident, not at random", () => {
    const e = run(city(), 10);
    const info = e.triggerCollision()!;
    const junction = info.segment_id.split("_")[0];

    const ambulance = e.dispatchAmbulanceTo(junction);
    expect(ambulance.destination).toBe(junction);
    // Regression: spawning at a random node put it *on* the incident roughly
    // one time in sixteen — no journey, no corridor, nothing to watch.
    expect(ambulance.route.length).toBeGreaterThan(1);
    expect(ambulance.route[ambulance.route.length - 1]).toBe(junction);
  });

  it("prefers a dispatch route that passes a signalised junction", () => {
    // Regression: priority is requested for junctions *ahead*, so an origin
    // whose only light is under its own wheels asked for nothing.
    const e = run(city(), 10);
    const info = e.triggerCollision()!;
    const junction = info.segment_id.split("_")[0];
    const ambulance = e.dispatchAmbulanceTo(junction);

    const reachable = [...e.grid.nodes.keys()]
      .filter((n) => n !== junction)
      .some((n) => e.grid.shortestPath(n, junction).slice(1).some((h) => e.trafficLights.has(h)));
    if (reachable)
      expect(ambulance.route.slice(1).some((h) => e.trafficLights.has(h))).toBe(true);
  });
});

describe("a wreck's sensors", () => {
  it("still shares what it can see", () => {
    // Regression: a crashed vehicle returned early from its tick, so it
    // announced the accident but never shared the pedestrian standing in
    // front of it — starving collective perception on the one road where a
    // stopped car is the only thing with a view.
    const e = run(new SimulationEngine({ seed: 4, gridSize: 4, numRsus: 9, numVehicles: 8, autoHazards: false }), 10);
    const info = e.triggerCollision()!;
    const wreck = e.vehicles.get(info.vehicles[0])!;
    expect(wreck.crashed).toBe(true);

    wreck.seenPedestrians = new Map([[info.segment_id, e.tick]]);
    const { outbound } = wreck.step(e.tick, true, true);
    expect(outbound.some((m) => m.type === "cpm")).toBe(true);
  });
});
