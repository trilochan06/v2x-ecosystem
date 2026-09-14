/** Experimental evaluation, client-side. Port of
 *  `backend/app/experiments/runner.py`.
 *
 *  All three configurations run over the same scenario and the same seed, so
 *  the only independent variable is the architecture. Every run includes a
 *  scripted cloud outage, which is how availability under disruption is
 *  measured rather than asserted.
 */
import { CONFIGS, SimulationEngine } from "./engine";
import { separated, summarize } from "./stats";
import type { Estimate, ExperimentRun, ExperimentSuite, Scenario } from "../types";

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

// Exp 4 differs from Exp 3 in exactly one flag, so the comparison isolates
// intent coordination rather than a bundle of changes moving together.
export const CONFIG_KEYS = ["exp1_centralized", "exp2_v2x_no_edge_ai", "exp3_full", "exp4_coordinated"];

/** Seeds per configuration. One seed is a sample, not a result. */
export const DEFAULT_REPEATS = 3;
export const MAX_REPEATS = 10;

/** The metrics worth aggregating across seeds, as a path into a summary. */
const AGGREGATED_METRICS: Record<string, [keyof ExperimentRun["metrics"], string]> = {
  uplink_kilobytes_per_tick: ["communication", "uplink_kilobytes_per_tick"],
  local_kilobytes_per_tick: ["communication", "local_kilobytes_per_tick"],
  packet_delivery_ratio: ["communication", "packet_delivery_ratio"],
  avg_alert_latency_ticks: ["communication", "avg_alert_latency_ticks"],
  alert_samples: ["communication", "alert_samples"],
  precision: ["detection", "precision"],
  recall: ["detection", "recall"],
  f1: ["detection", "f1"],
  segments_per_100_vehicle_ticks: ["traffic", "segments_per_100_vehicle_ticks"],
  congestion_duration_pct: ["traffic", "congestion_duration_pct"],
  availability_during_outage_pct: ["resilience", "availability_during_outage_pct"],
};

export function aggregateRuns(runs: ExperimentRun[]): Record<string, Estimate> {
  const out: Record<string, Estimate> = {};
  for (const [name, [section, key]] of Object.entries(AGGREGATED_METRICS)) {
    const values = runs.map((r) => Number((r.metrics[section] as Record<string, number>)[key]));
    out[name] = summarize(values);
  }
  return out;
}

/**
 * Run all three architectures over `repeats` seeds each.
 *
 * Every configuration sees the *same* seeds, so a difference between them
 * cannot come from one having drawn an easier run.
 *
 * `onProgress` is called after each individual run: the whole suite is
 * synchronous and blocks the main thread, so the caller needs a way to show
 * the user that something is happening.
 */
export function runSuite(
  scenarioKey: string,
  ticks: number,
  seed: number,
  repeats: number = DEFAULT_REPEATS,
  onProgress?: (done: number, total: number) => void,
): ExperimentSuite {
  const scenario = SCENARIOS.find((s) => s.key === scenarioKey) ?? SCENARIOS[0];
  const n = Math.max(1, Math.min(repeats, MAX_REPEATS));
  const seeds = Array.from({ length: n }, (_, i) => seed + i);
  const total = CONFIG_KEYS.length * n;

  let done = 0;
  const byConfig = CONFIG_KEYS.map((key) =>
    seeds.map((s) => {
      const run = runExperiment(key, scenario, ticks, s);
      onProgress?.(++done, total);
      return run;
    }),
  );

  const aggregates = byConfig.map((runs) => aggregateRuns(runs));
  return {
    scenario,
    ticks,
    seed,
    seeds,
    repeats: n,
    // The first seed's runs, kept for the per-configuration detail tables.
    runs: byConfig.map((runs) => runs[0]),
    aggregates: CONFIG_KEYS.map((key, i) => ({ config_key: key, metrics: aggregates[i] })),
    headline: headline(aggregates),
  };
}

function headline(aggregates: Record<string, Estimate>[]) {
  const [baseline, , full] = aggregates;

  const compare = (metric: string, unit: string, label: string, higherIsBetter = false) => {
    const b = baseline[metric];
    const p = full[metric];
    return {
      baseline: b.mean,
      baseline_half_width: b.half_width,
      proposed: p.mean,
      proposed_half_width: p.half_width,
      improvement_pct: higherIsBetter
        ? Math.round((p.mean - b.mean) * 100) / 100
        : pctDrop(b.mean, p.mean),
      samples: p.n,
      // Overlapping intervals mean the seeds do not separate these two, and
      // the site says so rather than reporting the difference.
      separated: separated(b, p),
      unit,
      label,
    };
  };

  return {
    alert_latency: compare("avg_alert_latency_ticks", "ticks", "Hazard-to-warning latency"),
    // Uplink specifically: the backhaul resource a cloud-only design saturates
    // with raw telemetry, and what the bandwidth/privacy argument is about.
    message_overhead: compare("uplink_kilobytes_per_tick", "KB/tick", "Uplink overhead"),
    availability_during_outage: compare(
      "availability_during_outage_pct",
      "%",
      "Availability during cloud outage",
      true,
    ),
  };
}

const pctDrop = (baseline: number, proposed: number) =>
  baseline <= 0 ? 0 : Math.round(((baseline - proposed) / baseline) * 10000) / 100;
