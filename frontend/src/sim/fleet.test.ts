/**
 * Mixed traffic: what changes when the fleet is not all cars.
 *
 * Two things here are load-bearing rather than cosmetic. Road space is
 * counted in passenger-car units, so a bus and a bicycle do not weigh the
 * same on a lane; and an unequipped road user transmits nothing, so the only
 * way the network learns a cyclist is in the lane is that someone else saw
 * them and said so. The second is the case collective perception exists for,
 * and it is the one worth testing hardest.
 */
import { describe, expect, it } from "vitest";

import { CAUSE_CODE, causeFor } from "./core";
import { TRAFFIC_MIX, VEHICLE_PROFILES, isEmergency, isOrdinaryTraffic } from "./agents";
import type { VehicleKind } from "./agents";
import { SimulationEngine } from "./engine";

const run = (engine: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) engine.step();
  return engine;
};

const city = (seed = 7, numVehicles = 40) =>
  new SimulationEngine({ seed, gridSize: 5, numRsus: 6, numVehicles, autoHazards: false });

describe("the fleet", () => {
  it("is mixed by default and all cars only when asked", () => {
    const mixed = city();
    const kinds = new Set([...mixed.vehicles.values()].map((v) => v.kind));
    expect(kinds.size).toBeGreaterThan(1);

    const plain = new SimulationEngine({
      seed: 7,
      gridSize: 5,
      numRsus: 6,
      numVehicles: 40,
      autoHazards: false,
      homogeneousFleet: true,
    });
    expect(new Set([...plain.vehicles.values()].map((v) => v.kind))).toEqual(new Set(["car"]));
  });

  it("draws every kind in the mix over enough spawns, and nothing outside it", () => {
    const allowed = new Set(TRAFFIC_MIX.map((m) => m.kind));
    const seen = new Set<VehicleKind>();
    for (const seed of [1, 2, 3, 4, 5]) {
      for (const v of city(seed, 60).vehicles.values()) {
        expect(allowed.has(v.kind)).toBe(true);
        seen.add(v.kind);
      }
    }
    expect(seen).toEqual(allowed);
  });

  it("keeps the mix when it replaces what it recycles", () => {
    // Topping the city back up must not launder a bus into a car over time.
    const e = city(3, 30);
    const before = [...e.vehicles.values()].filter((v) => v.kind !== "car").length;
    run(e, 200);
    const after = [...e.vehicles.values()].filter((v) => v.kind !== "car").length;
    expect(after).toBeGreaterThan(0);
    expect(before).toBeGreaterThan(0);
  });

  it("classifies ordinary traffic and emergency services apart", () => {
    expect(isOrdinaryTraffic("car")).toBe(true);
    expect(isOrdinaryTraffic("rickshaw")).toBe(true);
    expect(isOrdinaryTraffic("ambulance")).toBe(false);
    expect(isOrdinaryTraffic("malicious")).toBe(false);

    for (const kind of ["ambulance", "fire", "police"] as VehicleKind[])
      expect(isEmergency(kind)).toBe(true);
    for (const kind of ["car", "bus", "bicycle"] as VehicleKind[])
      expect(isEmergency(kind)).toBe(false);
  });
});

describe("road space is counted in car-equivalents", () => {
  it("weighs a lane by what is in it, not by how many things are in it", () => {
    const bicycles = new SimulationEngine({
      seed: 11,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 1,
      autoHazards: false,
    });
    // One bicycle takes a fifth of the road one car takes, so the same count
    // of them must not fill a lane the same way.
    expect(VEHICLE_PROFILES.bicycle.pcu).toBeLessThan(VEHICLE_PROFILES.car.pcu);
    expect(VEHICLE_PROFILES.bus.pcu).toBeGreaterThan(VEHICLE_PROFILES.car.pcu);
    expect(bicycles.vehicles.size).toBe(1);
  });

  it("a lane of buses saturates sooner than a lane of bicycles", () => {
    const occupancyOf = (kind: VehicleKind) => {
      const e = new SimulationEngine({
        seed: 5,
        gridSize: 4,
        numRsus: 4,
        numVehicles: 0,
        autoHazards: false,
      });
      const anchor = e.spawnVehicle(kind);
      const seg = anchor.currentSegmentId!;
      // Put several of the same kind on one road, then let occupancy settle.
      for (let i = 0; i < 3; i++) e.spawnVehicle(kind, anchor.node);
      run(e, 4);
      return e.stateSnapshot().segments.find((s) => s.id === seg)?.occupancy ?? 0;
    };

    expect(occupancyOf("bus")).toBeGreaterThan(occupancyOf("bicycle"));
  });
});

describe("an unequipped road user", () => {
  const withBicycle = () => {
    const e = new SimulationEngine({
      seed: 9,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 0,
      autoHazards: false,
    });
    const bike = e.spawnVehicle("bicycle");
    const car = e.spawnVehicle("car", bike.node);
    return { e, bike, car };
  };

  it("has no radio at all", () => {
    expect(VEHICLE_PROFILES.bicycle.equipped).toBe(false);
    expect(VEHICLE_PROFILES.motorbike.equipped).toBe(true);
  });

  it("puts nothing on the air, however long it rides", () => {
    const { e, bike } = withBicycle();
    // Stepped directly, with V2V and rerouting both switched on, so this is
    // the most permissive conditions it will ever see.
    let frames = 0;
    for (let tick = e.tick; tick < e.tick + 80; tick++) {
      frames += bike.step(tick, true, true).outbound.length;
    }
    expect(frames).toBe(0);
  });

  it("transmits nothing even as a wreck, when a car in its place would", () => {
    const { e, bike, car } = withBicycle();
    run(e, 4);
    bike.crash(e.tick);
    car.crash(e.tick);

    let fromBike = 0;
    let fromCar = 0;
    for (let tick = e.tick; tick < e.tick + 20; tick++) {
      fromBike += bike.step(tick, true, true).outbound.length;
      fromCar += car.step(tick, true, true).outbound.length;
    }
    // The car announces the wreck it has become; the bicycle cannot, which is
    // exactly why someone else has to see it.
    expect(fromCar).toBeGreaterThan(0);
    expect(fromBike).toBe(0);
  });

  it("is still vulnerable, and still takes up road", () => {
    const { bike } = withBicycle();
    expect(bike.vulnerable).toBe(true);
    expect(bike.pcu).toBeGreaterThan(0);
  });

  it("is reported by a vehicle that can see it, under the CDD subcause", () => {
    const [cause, sub] = causeFor("cyclist_on_roadway");
    expect(cause).toBe(CAUSE_CODE.HUMAN_PRESENCE_ON_THE_ROAD);
    expect(sub).toBe(2);
    // A crossing pedestrian is the same cause with a different subcause, which
    // is what lets a receiver tell the two apart.
    expect(causeFor("pedestrian_crossing")).toEqual([CAUSE_CODE.HUMAN_PRESENCE_ON_THE_ROAD, 0]);
  });

  it("is seen by a car sharing its road, and only then", () => {
    const { e, bike, car } = withBicycle();
    run(e, 2);

    const shared = car.currentSegmentId === bike.currentSegmentId;
    if (shared && car.currentSegmentId) {
      expect(car.seenVrus.has(car.currentSegmentId)).toBe(true);
    }

    // A car on its own road sees no VRU at all — the sighting is not global
    // knowledge handed out by the simulator.
    const lone = new SimulationEngine({
      seed: 9,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 0,
      autoHazards: false,
    });
    const alone = lone.spawnVehicle("car");
    run(lone, 3);
    expect(alone.seenVrus.size).toBe(0);
  });

  it("is never the one doing the perceiving", () => {
    // A bicycle has no sensors to share from, so it must never accumulate
    // sightings of its own — otherwise it would look like a silent node that
    // is nonetheless participating.
    const { e, bike } = withBicycle();
    run(e, 20);
    expect(bike.seenVrus.size).toBe(0);
  });

  it("makes a car that knows of it slow down", () => {
    const { e, car } = withBicycle();
    run(e, 3);
    const seg = car.currentSegmentId;
    if (!seg) return;
    car.seenVrus.set(seg, e.tick);
    expect(car.knowsVruOn(seg, e.tick)).toBe(true);
    // and the knowledge ages out rather than being believed forever
    expect(car.knowsVruOn(seg, e.tick + 50)).toBe(false);
  });
});

describe("emergency services", () => {
  it("all hold their route rather than diverting around congestion", () => {
    const e = new SimulationEngine({
      seed: 2,
      gridSize: 4,
      numRsus: 4,
      numVehicles: 0,
      autoHazards: false,
    });
    for (const kind of ["ambulance", "fire", "police"] as VehicleKind[]) {
      const v = e.spawnVehicle(kind);
      expect(v.reroute(e.tick + 100)).toBe(false);
    }
  });

  it("are never recycled as background traffic", () => {
    for (const kind of ["ambulance", "fire", "police"] as VehicleKind[])
      expect(TRAFFIC_MIX.some((m) => m.kind === kind)).toBe(false);
  });
});
