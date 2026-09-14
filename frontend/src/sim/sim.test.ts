/**
 * Tests for the browser engine.
 *
 * The hosted site runs this TypeScript port, not the Python reference, so it
 * needs its own tests. The byte constants below are pinned to exactly the
 * same values as `backend/tests/test_messages.py`: if either side drifts, one
 * of the two suites fails.
 */
import { describe, expect, it } from "vitest";

import {
  CERTIFICATE_BYTES,
  CERTIFICATE_DIGEST_BYTES,
  CertificateAttachmentPolicy,
  MESSAGE_SPECS,
  backhaulBytes,
  causeFor,
  makeMessage,
  messageBytes,
  securityBytes,
} from "./core";
import { separated, summarize, tMultiplier } from "./stats";
import { SCENARIOS, aggregateRuns, runExperiment, runSuite } from "./experiments";
import { SimulationEngine } from "./engine";

const cam = (over: Partial<Parameters<typeof makeMessage>[0]> = {}) =>
  makeMessage({
    type: "cam",
    senderId: "v1",
    pseudonym: "p1",
    payload: { segment_id: "0-0_1-0" },
    ttl: 2,
    createdTick: 0,
    signed: true,
    ...over,
  });

const denm = (over: Partial<Parameters<typeof makeMessage>[0]> = {}) =>
  cam({ type: "denm-hazard", ...over });

// ------------------------------------------------------------- frame sizes
describe("C-ITS frame sizing", () => {
  it("prices a signed CAM exactly as the Python reference does", () => {
    // 4 ITS PDU header + 117 payload + 64 signature + 17 SignedData + 8 digest
    expect(messageBytes(cam({ certificateAttached: false }))).toBe(210);
    // ... and 117 for the full certificate instead of the 8-byte digest
    expect(messageBytes(cam({ certificateAttached: true }))).toBe(319);
  });

  it("prices a signed DENM exactly as the Python reference does", () => {
    expect(messageBytes(denm({ certificateAttached: false }))).toBe(273);
    expect(messageBytes(denm({ certificateAttached: true }))).toBe(382);
  });

  it("does not let the size depend on the payload's JavaScript shape", () => {
    const short = denm({ payload: { a: 1 } });
    const long = denm({ payload: { a_very_long_key_name_indeed: "and a long value too" } });
    expect(messageBytes(short)).toBe(messageBytes(long));
  });

  it("charges variable content on top of the frame", () => {
    const plain = makeMessage({ ...denm(), type: "denm-eva" });
    const withPath = makeMessage({ ...denm(), type: "denm-eva", variableBytes: 48 });
    expect(messageBytes(withPath) - messageBytes(plain)).toBe(48);
  });

  it("exempts backhaul traffic from the 1609.2 envelope", () => {
    const probe = cam({ type: "telemetry-upload" });
    expect(MESSAGE_SPECS["telemetry-upload"].bearer).toBe("backhaul");
    expect(securityBytes(probe)).toBe(0);
    expect(messageBytes(probe)).toBe(92); // 20 framing + 72 payload
  });

  it("sizes an uploaded observation as backhaul, not as a secured DENM", () => {
    const frame = denm({ certificateAttached: true });
    expect(backhaulBytes(frame)).toBe(200);
    expect(backhaulBytes(frame)).toBeLessThan(messageBytes(frame));
  });

  it("charges nothing for security on an unsigned frame", () => {
    expect(securityBytes(cam({ signed: false }))).toBe(0);
  });
});

// ---------------------------------------------- certificate attachment
describe("certificate attachment policy", () => {
  it("attaches a certificate periodically, not on every frame", () => {
    const policy = new CertificateAttachmentPolicy(10);
    const attached = Array.from({ length: 30 }, () => policy.attach("pseudo-1"));

    expect(attached[0]).toBe(true);
    expect(attached.slice(1, 10)).toEqual(Array(9).fill(false));
    expect(attached.filter(Boolean)).toHaveLength(3);
    expect(policy.digestsAttached).toBe(27);
  });

  it("resends the certificate after a pseudonym rotation", () => {
    // Receivers cache a certificate against the pseudonym that sent it, so
    // unlinkability costs bandwidth. That trade is the point of the test.
    const policy = new CertificateAttachmentPolicy(10);
    policy.attach("pseudo-1");
    expect(policy.attach("pseudo-1")).toBe(false);
    expect(policy.attach("pseudo-2")).toBe(true);
  });

  it("reports what sending digests saved", () => {
    const policy = new CertificateAttachmentPolicy(10);
    for (let i = 0; i < 10; i++) policy.attach("pseudo-1");
    expect(policy.bytesSaved).toBe(9 * (CERTIFICATE_BYTES - CERTIFICATE_DIGEST_BYTES));
    expect(policy.snapshot().frames_secured).toBe(10);
  });
});

// ------------------------------------------------------------- cause codes
describe("DENM cause codes", () => {
  it("maps hazard labels onto the Common Data Dictionary", () => {
    expect(causeFor("accident")).toEqual([2, 0]);
    expect(causeFor("stalled_vehicle")).toEqual([94, 2]); // vehicleBreakdown
    expect(causeFor("oil_spill")).toEqual([6, 2]); // fuelOnTheRoad
    expect(causeFor("fog_bank")).toEqual([19, 1]); // fog
  });

  it("degrades an unknown hazard to a valid cause code", () => {
    expect(causeFor("not_in_the_dictionary")).toEqual([99, 0]);
  });
});

// -------------------------------------------------------------- statistics
describe("confidence intervals", () => {
  it("uses Student's t rather than the normal approximation at small n", () => {
    expect(tMultiplier(2)).toBeCloseTo(4.303, 3);
    expect(tMultiplier(2)).toBeGreaterThan(1.96 * 2);
  });

  it("tends to the normal value for large samples", () => {
    expect(tMultiplier(1000)).toBeCloseTo(1.96, 2);
    expect(tMultiplier(9)).toBeGreaterThan(tMultiplier(60));
  });

  it("computes a known interval", () => {
    const est = summarize([10, 12, 14]);
    expect(est.mean).toBeCloseTo(12, 6);
    expect(est.stdev).toBeCloseTo(2, 6);
    expect(est.half_width).toBeCloseTo((4.303 * 2) / Math.sqrt(3), 3);
  });

  it("refuses to call a single seed a result", () => {
    expect(summarize([42]).reportable).toBe(false);
    expect(summarize([]).n).toBe(0);
  });

  it("only claims separation when the intervals actually separate", () => {
    expect(separated(summarize([10, 11, 12]), summarize([11, 12, 13]))).toBe(false);
    expect(separated(summarize([1, 1.1, 0.9]), summarize([50, 50.1, 49.9]))).toBe(true);
  });
});

// ------------------------------------------------------------ the engine
describe("simulation engine", () => {
  it("is deterministic for a given seed", () => {
    const a = runExperiment("exp3_full", SCENARIOS[0], 60, 7);
    const b = runExperiment("exp3_full", SCENARIOS[0], 60, 7);
    expect(a.metrics).toEqual(b.metrics);
  });

  it("gives different seeds different runs", () => {
    const a = runExperiment("exp3_full", SCENARIOS[0], 60, 1);
    const b = runExperiment("exp3_full", SCENARIOS[0], 60, 2);
    expect(a.metrics).not.toEqual(b.metrics);
  });

  it("emits CAMs and DENMs, and no probe traffic, on the decentralized config", () => {
    const run = runExperiment("exp3_full", SCENARIOS[0], 120, 4242);
    const frames = run.metrics.communication.frames_by_designator;
    expect(frames.CAM).toBeGreaterThan(0);
    expect(frames.probe).toBeUndefined();
  });

  it("streams probe data and nothing else on the centralized baseline", () => {
    const run = runExperiment("exp1_centralized", SCENARIOS[0], 120, 4242);
    const frames = run.metrics.communication.frames_by_designator;
    expect(frames.probe).toBeGreaterThan(0);
    expect(frames.CAM).toBeUndefined();
    // No sidelink radio means nothing on the air locally.
    expect(run.metrics.communication.local_kilobytes).toBe(0);
  });

  it("keeps serving during the cloud outage only when it does not need the cloud", () => {
    const centralized = runExperiment("exp1_centralized", SCENARIOS[0], 120, 4242);
    const decentralized = runExperiment("exp3_full", SCENARIOS[0], 120, 4242);
    expect(centralized.metrics.resilience.availability_during_outage_pct).toBe(0);
    expect(decentralized.metrics.resilience.availability_during_outage_pct).toBe(100);
  });
});

// ---------------------------------------------------------- the harness
describe("experiment suite", () => {
  it("runs every configuration over the same seeds and reports intervals", () => {
    const suite = runSuite("normal", 60, 99, 2);
    expect(suite.repeats).toBe(2);
    expect(suite.seeds).toEqual([99, 100]);
    expect(suite.aggregates).toHaveLength(3);
    expect(suite.headline.message_overhead.samples).toBe(2);
    expect(suite.headline.message_overhead).toHaveProperty("separated");
  });

  it("clamps the repeat count to a sane range", () => {
    expect(runSuite("normal", 60, 5, 0).repeats).toBe(1);
  });

  it("reports progress as it goes, because the suite blocks the main thread", () => {
    const seen: number[] = [];
    runSuite("normal", 30, 5, 2, (done, total) => {
      expect(total).toBe(6);
      seen.push(done);
    });
    expect(seen).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("aggregates every tracked metric", () => {
    const runs = [1, 2].map((s) => runExperiment("exp3_full", SCENARIOS[0], 60, s));
    const agg = aggregateRuns(runs);
    expect(agg.uplink_kilobytes_per_tick.n).toBe(2);
    expect(agg).toHaveProperty("f1");
    expect(agg).toHaveProperty("availability_during_outage_pct");
  });
});

// ------------------------------------------------- the street-level view
describe("transmission log", () => {
  const run = (ticks: number, seed = 5) => {
    const e = new SimulationEngine({
      gridSize: 4,
      numRsus: 4,
      numVehicles: 6,
      seed,
      autoHazards: false,
      inferenceInterval: 2,
    });
    e.spawnVehicle("ambulance");
    e.injectHazard();
    for (let i = 0; i < ticks; i++) e.step();
    return e;
  };

  it("records who transmitted and who decoded it", () => {
    const frames = run(60).stateSnapshot().transmissions;
    expect(frames.length).toBeGreaterThan(0);
    for (const f of frames) {
      expect(f.sender_id).toBeTruthy();
      expect(Array.isArray(f.delivered_to)).toBe(true);
      expect(f.delivered_to.length).toBeLessThanOrEqual(f.intended);
    }
  });

  it("stays bounded — it ships inside every snapshot", () => {
    expect(run(400).stateSnapshot().transmissions.length).toBeLessThanOrEqual(60);
  });

  it("never names a receiver that does not exist", () => {
    const e = run(80);
    const state = e.stateSnapshot();
    const known = new Set([
      ...state.vehicles.map((v) => v.id),
      ...state.rsus.map((r) => r.id),
    ]);
    for (const f of state.transmissions)
      for (const rx of f.delivered_to) expect(known.has(rx)).toBe(true);
  });

  it("only ever names senders the map can place", () => {
    // Regression: traffic lights transmit SPaT and SSEM under "light-<node>".
    // The street map could not resolve that id, so those frames were silently
    // dropped from the drawing while the legend promised to show them.
    const e = run(80);
    const state = e.stateSnapshot();
    const vehicles = new Set(state.vehicles.map((v) => v.id));
    const rsus = new Set(state.rsus.map((r) => r.id));
    const lights = new Set(state.traffic_lights.map((l) => `light-${l.node}`));

    for (const f of state.transmissions) {
      const locatable = vehicles.has(f.sender_id) || rsus.has(f.sender_id) || lights.has(f.sender_id);
      expect(locatable, `${f.designator} sent by unlocatable ${f.sender_id}`).toBe(true);
    }
  });

  it("carries the signal frames the street view colours separately", () => {
    const designators = new Set(run(120).stateSnapshot().transmissions.map((f) => f.designator));
    // SPaT goes out on a duty cycle regardless of what else is happening.
    expect(designators.has("SPATEM")).toBe(true);
  });
});

// ------------------------------------------------------ traffic density
describe("traffic density control", () => {
  const city = () => new SimulationEngine({ gridSize: 5, numRsus: 4, numVehicles: 12, seed: 9 });

  it("thins the city out and fills it back up", () => {
    const e = city();
    e.setVehicleCount(5);
    expect(e.vehicles.size).toBe(5);
    e.setVehicleCount(18);
    expect(e.vehicles.size).toBe(18);
  });

  it("keeps the ambulance and the attacker when thinning", () => {
    // Removing the vehicle somebody just dispatched to watch would be its own
    // kind of confusing.
    const e = city();
    const amb = e.spawnVehicle("ambulance").id;
    const bad = e.spawnVehicle("malicious").id;
    e.setVehicleCount(3);
    expect(e.vehicles.has(amb)).toBe(true);
    expect(e.vehicles.has(bad)).toBe(true);
  });

  it("stops counting a removed vehicle as served by its RSU", () => {
    // Regression: the RSU cell assignment outlived the vehicle, so the cell
    // sizes kept counting cars that no longer existed.
    const e = city();
    for (let i = 0; i < 10; i++) e.step();
    e.setVehicleCount(4);
    const served = e.stateSnapshot().rsus.reduce((s, r) => s + r.cell_size, 0);
    expect(served).toBeLessThanOrEqual(e.vehicles.size);
  });

  it("keeps stepping cleanly after vehicles are removed", () => {
    const e = city();
    for (let i = 0; i < 15; i++) e.step();
    e.setVehicleCount(2);
    for (let i = 0; i < 25; i++) e.step();
    expect(e.vehicles.size).toBe(2);
    expect(e.stateSnapshot().tick).toBe(40);
  });
});
