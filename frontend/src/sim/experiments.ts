/** Experimental evaluation, client-side. Port of
 *  `backend/app/experiments/runner.py`.
 *
 *  All three configurations run over the same scenario and the same seed, so
 *  the only independent variable is the architecture. Every run includes a
 *  scripted cloud outage, which is how availability under disruption is
 *  measured rather than asserted.
 */
import { CONFIGS, SimulationEngine } from "./engine";
import type { ExperimentRun, ExperimentSuite, Scenario } from "../types";

const OUTAGE_START_FRACTION = 0.55;
const OUTAGE_END_FRACTION = 0.75;

export const SCENARIOS: Scenario[] = [
  {
    key: "normal",
    label: "Normal traffic",
    description: "Steady flow with organically occurring hazards.",
    vehicles: 26,
    malicious: 0,
    ambulances: 0,
  },
  {
    key: "congestion",
    label: "Sudden congestion",
    description: "Heavy load: more vehicles than the grid comfortably carries.",
    vehicles: 44,
    malicious: 0,
    ambulances: 0,
  },
  {
    key: "emergency",
    label: "Emergency vehicle routing",
    description: "Ambulances need a corridor through live traffic.",
    vehicles: 30,
    malicious: 0,
    ambulances: 2,
  },
  {
    key: "attack",
    label: "Malicious injection",
    description: "Attackers inject false hazard reports into the network.",
    vehicles: 30,
    malicious: 4,
    ambulances: 0,
  },
];

export function runExperiment(
  configKey: string,
  scenario: Scenario,
  ticks: number,
  seed: number,
): ExperimentRun {
  const config = CONFIGS[configKey];
  const engine = new SimulationEngine({
    numVehicles: scenario.vehicles,
    config,
    seed,
    inferenceInterval: 3,
    explainPredictions: false,
  });
  for (let i = 0; i < scenario.malicious; i++) engine.spawnVehicle("malicious");
  for (let i = 0; i < scenario.ambulances; i++) engine.spawnVehicle("ambulance");

  const outageStart = Math.floor(ticks * OUTAGE_START_FRACTION);
  const outageEnd = Math.floor(ticks * OUTAGE_END_FRACTION);

  for (let t = 0; t < ticks; t++) {
    if (t === outageStart) engine.setCloudOnline(false);
    else if (t === outageEnd) engine.setCloudOnline(true);
    engine.step();
  }

  const fed = engine.federation.snapshot();
  return {
    config,
    scenario,
    ticks,
    seed,
    metrics: engine.metrics.summary(),
    federated: {
      rounds_completed: fed.rounds_completed,
      loss_reduction_pct: fed.loss_reduction_pct,
      convergence_round: fed.convergence_round,
      raw_kilobytes_avoided: fed.total_raw_kilobytes_avoided,
      weights_kilobytes: fed.total_weights_kilobytes,
    },
    digital_twin: engine.twin.snapshot(engine.tick),
    outage_window: { start: outageStart, end: outageEnd },
  } as ExperimentRun;
}

export function runSuite(scenarioKey: string, ticks: number, seed: number): ExperimentSuite {
  const scenario = SCENARIOS.find((s) => s.key === scenarioKey) ?? SCENARIOS[0];
  const runs = ["exp1_centralized", "exp2_v2x_no_edge_ai", "exp3_full"].map((key) =>
    runExperiment(key, scenario, ticks, seed),
  );
  return { scenario, ticks, seed, runs, headline: headline(runs) };
}

function headline(runs: ExperimentRun[]) {
  const [baseline, , full] = runs;
  const latency = (r: ExperimentRun) => r.metrics.communication.avg_alert_latency_ticks;
  // Uplink specifically: the backhaul resource a cloud-only design saturates
  // with raw telemetry, and what the bandwidth/privacy argument is about.
  const overhead = (r: ExperimentRun) => r.metrics.communication.uplink_kilobytes_per_tick;
  const availability = (r: ExperimentRun) => r.metrics.resilience.availability_during_outage_pct;

  return {
    alert_latency: {
      baseline: latency(baseline),
      proposed: latency(full),
      improvement_pct: pctDrop(latency(baseline), latency(full)),
      unit: "ticks",
      label: "Hazard-to-warning latency",
    },
    message_overhead: {
      baseline: overhead(baseline),
      proposed: overhead(full),
      improvement_pct: pctDrop(overhead(baseline), overhead(full)),
      unit: "KB/tick",
      label: "Uplink overhead",
    },
    availability_during_outage: {
      baseline: availability(baseline),
      proposed: availability(full),
      improvement_pct: Math.round((availability(full) - availability(baseline)) * 100) / 100,
      unit: "%",
      label: "Availability during cloud outage",
    },
  };
}

const pctDrop = (baseline: number, proposed: number) =>
  baseline <= 0 ? 0 : Math.round(((baseline - proposed) / baseline) * 10000) / 100;
