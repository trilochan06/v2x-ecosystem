/**
 * Intent coordination (M6b) — a tested hypothesis with a negative result.
 *
 * Mirrors `backend/tests/test_intent_coordination.py`. The proposition was
 * that greedy rerouting herds: every vehicle hears the same congestion report,
 * computes the same detour, and arrives on it together. The mechanism here
 * does break that — and does not improve throughput, while costing a great
 * deal of bandwidth. These tests pin it so the negative result stays
 * reproducible rather than becoming folklore; the figures are in the README.
 */
import { describe, expect, it } from "vitest";

import { CityGrid, MESSAGE_SPECS, makeRng } from "./core";
import { Vehicle } from "./agents";
import { CONFIGS, SimulationEngine } from "./engine";

const city = (key: string, seed = 4, numVehicles = 10) =>
  new SimulationEngine({ seed, gridSize: 5, numRsus: 4, numVehicles, config: CONFIGS[key], autoHazards: false });

const run = (e: SimulationEngine, ticks: number) => {
  for (let i = 0; i < ticks; i++) e.step();
  return e;
};

const planner = (id: string, grid: CityGrid, from: string, to: string) => {
  const v = new Vehicle(id, "car", grid, from, 42, makeRng(1), 0);
  v.destination = to;
  v.route = grid.shortestPath(from, to);
  v.intentCoordination = true;
  return v;
};

describe("the MCM frame", () => {
  it("is a standard frame", () => {
    expect(MESSAGE_SPECS.mcm.designator).toBe("MCM");
    expect(MESSAGE_SPECS.mcm.standard).toBe("ETSI TR 103 578");
  });

  it("does not let an attacker announce intent", () => {
    // A liar claiming every road would steer honest traffic away from it.
    const e = city("exp4_coordinated");
    expect(e.spawnVehicle("malicious").maybeShareIntent(0)).toBeNull();
  });
});

describe("intent as peer knowledge", () => {
  it("only counts what was actually delivered", () => {
    const e = run(city("exp4_coordinated"), 4);
    const v = [...e.vehicles.values()][0];
    v.peerIntent.clear();

    expect(v.claimedByPeers("0-0_1-0", e.tick)).toBe(0);
    v.receiveIntent(["0-0_1-0"], e.tick);
    expect(v.claimedByPeers("0-0_1-0", e.tick)).toBe(1);
  });

  it("stops counting a stale claim", () => {
    const e = run(city("exp4_coordinated"), 4);
    const v = [...e.vehicles.values()][0];
    v.receiveIntent(["0-0_1-0"], 0);
    expect(v.claimedByPeers("0-0_1-0", 0)).toBe(1);
    expect(v.claimedByPeers("0-0_1-0", 500)).toBe(0);
  });
});

describe("herding, and the fix", () => {
  it("makes identical vehicles stop computing identical detours", () => {
    // Every road is the same length, so the search is really minimising hop
    // count and ties are everywhere. Broken the same way in every vehicle, two
    // cars in the same place heading the same way get identical detours.
    const grid = new CityGrid(6);
    const avoid = new Set(["2-2_3-2"]);
    const routes = new Set<string>();
    for (let i = 0; i < 6; i++)
      routes.add(planner(`car-${i}`, grid, "0-0", "5-5").detour(avoid, 10).join(">"));
    expect(routes.size).toBeGreaterThan(1);
  });

  it("still herds without coordination — the behaviour being fixed", () => {
    const grid = new CityGrid(6);
    const avoid = new Set(["2-2_3-2"]);
    const routes = new Set<string>();
    for (let i = 0; i < 6; i++) {
      const v = planner(`car-${i}`, grid, "0-0", "5-5");
      v.intentCoordination = false;
      routes.add(v.detour(avoid, 10).join(">"));
    }
    expect(routes.size).toBe(1);
  });

  it("never sends anyone the long way round", () => {
    // A tie-break must not overpower a genuinely shorter route.
    const grid = new CityGrid(6);
    const shortest = grid.shortestPath("0-0", "3-3").length;
    for (let i = 0; i < 12; i++)
      expect(planner(`car-${i}`, grid, "0-0", "3-3").detour(new Set(), 0)).toHaveLength(shortest);
  });
});

describe("the weighted search", () => {
  it("agrees with the plain search on a uniform grid", () => {
    // Every road is 250 m, so a flat cost must reproduce the breadth-first
    // result — otherwise Exp 4 measures the algorithm swap, not coordination.
    const grid = new CityGrid(6);
    for (const goal of ["5-5", "0-5", "3-2"]) {
      const bfs = grid.shortestPath("0-0", goal);
      const dijkstra = grid.leastCostPath("0-0", goal, (s) => s.lengthM);
      expect(dijkstra).toHaveLength(bfs.length);
      expect(dijkstra[dijkstra.length - 1]).toBe(goal);
    }
  });

  it("reports an unreachable goal rather than inventing a route", () => {
    const grid = new CityGrid(4);
    expect(grid.leastCostPath("0-0", "3-3", () => Infinity)).toEqual([]);
  });
});

describe("how it ships", () => {
  it("is off in the proposed architecture", () => {
    // It was tested and did not pay for itself, so it is not in the baseline.
    expect(CONFIGS.exp3_full.intent_coordination ?? false).toBe(false);
    expect(CONFIGS.exp4_coordinated.intent_coordination).toBe(true);
  });

  it("differs from Exp 3 in exactly one flag", () => {
    const a = CONFIGS.exp3_full as unknown as Record<string, unknown>;
    const b = CONFIGS.exp4_coordinated as unknown as Record<string, unknown>;
    const differing = new Set<string>();
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      if (a[k] !== b[k] && !["key", "label", "summary"].includes(k)) differing.add(k);
    expect([...differing]).toEqual(["intent_coordination"]);
  });

  it("puts MCM on the air only when enabled", () => {
    const plain = run(city("exp3_full"), 30).metrics.summary().communication.frames_by_designator;
    const coordinated = run(city("exp4_coordinated"), 30).metrics.summary().communication.frames_by_designator;
    expect(plain.MCM ?? 0).toBe(0);
    expect(coordinated.MCM ?? 0).toBeGreaterThan(0);
  });

  it("costs bandwidth — the one thing it reliably does", () => {
    // Kept as a test because it is the finding: the cost separates cleanly
    // while the benefit does not.
    const plain = run(city("exp3_full", 4, 16), 60).metrics.summary().communication.local_kilobytes_per_tick;
    const coordinated = run(city("exp4_coordinated", 4, 16), 60).metrics.summary().communication.local_kilobytes_per_tick;
    expect(coordinated).toBeGreaterThan(plain);
  });

  it("is reproducible from its seed", () => {
    // The tie-break is a stable hash, not Math.random — a result nobody can
    // reproduce is a result nobody should believe.
    const a = run(city("exp4_coordinated", 7), 40).metrics.summary().traffic;
    const b = run(city("exp4_coordinated", 7), 40).metrics.summary().traffic;
    expect(a).toEqual(b);
  });
});
