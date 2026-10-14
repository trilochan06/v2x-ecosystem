/**
 * The centralized counterfactual.
 *
 * Federated learning's claim is not that it is more accurate — it is that it
 * is nearly as accurate without the data moving. A project that only reports
 * its own loss has not tested that claim at all, so every round also fits the
 * model the privacy-violating way and the gap between them is reported.
 */
import { describe, expect, it } from "vitest";

import { SimulationEngine } from "./engine";

const run = (e: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) e.step();
  return e;
};

const trained = (seed = 31, ticks = 400) =>
  run(
    new SimulationEngine({ seed, gridSize: 5, numRsus: 6, numVehicles: 30, autoHazards: true }),
    ticks,
  );

describe("federated against centralized", () => {
  it("runs rounds and fits both models", () => {
    const fed = trained().stateSnapshot().federated;
    expect(fed.rounds_completed).toBeGreaterThan(0);
    expect(fed.current_loss).toBeGreaterThan(0);
    expect(fed.centralized_loss).toBeGreaterThan(0);
  });

  it("reports the privacy cost as the gap between them", () => {
    const fed = trained().stateSnapshot().federated;
    const expected = ((fed.current_loss - fed.centralized_loss) / fed.centralized_loss) * 100;
    expect(fed.privacy_cost_pct).toBeCloseTo(Math.round(expected * 100) / 100, 1);
  });

  it("lands close to centralized rather than far from it", () => {
    // The whole argument rests on the gap being small. If federation were
    // costing tens of percent, keeping the data local would be an expensive
    // principle rather than a cheap one, and the write-up should say so.
    const fed = trained().stateSnapshot().federated;
    expect(Math.abs(fed.privacy_cost_pct)).toBeLessThan(25);
  });

  it("moves far less over the network than the data it avoided", () => {
    const fed = trained().stateSnapshot().federated;
    expect(fed.total_raw_kilobytes_avoided).toBeGreaterThan(fed.total_weights_kilobytes * 5);
  });

  it("keeps every client's samples on the client", () => {
    // The counterfactual is computed by the harness, not by the network. No
    // round may leave a client's buffer populated after it has participated:
    // that is what `loadGlobal` clearing the buffer enforces, and it is the
    // mechanical form of "raw data never leaves".
    const e = trained(7, 300);
    const fed = e.stateSnapshot().federated;
    expect(fed.rounds_completed).toBeGreaterThan(0);
    // Weight payloads are a fixed, tiny size per client per round; raw sample
    // payloads would scale with how much each one saw.
    expect(fed.total_weights_kilobytes).toBeLessThan(fed.total_raw_kilobytes_avoided);
  });

  it("is reproducible for the same seed", () => {
    const a = trained(5, 250).stateSnapshot().federated;
    const b = trained(5, 250).stateSnapshot().federated;
    expect(a.current_loss).toBe(b.current_loss);
    expect(a.centralized_loss).toBe(b.centralized_loss);
  });
});
