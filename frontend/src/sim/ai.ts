/** M6 congestion forecasting and M7 federated learning, client-side.
 *
 * The congestion model is NOT reimplemented: `model.json` holds the exact
 * gradient-boosted trees fitted by the Python pipeline, and the walk below
 * reproduces scikit-learn's prediction to within 5e-07. That keeps the
 * hosted demo numerically faithful to the results in the report.
 *
 * Federated learning is a linear model, so FedAvg here is the same
 * sample-weighted mean of client parameters as the Python implementation.
 */
import modelArtifact from "./model.json";
import valset from "./valset.json";
import type { Segment } from "./core";

export const FEATURE_NAMES = modelArtifact.features as string[];
export const FEATURE_DIM = FEATURE_NAMES.length;
export const PREDICTION_HORIZON_TICKS = 30;
const DAY_CYCLE_TICKS = 400;

interface TreeJson {
  l: number[];
  r: number[];
  f: number[];
  t: number[];
  v: number[];
}
const TREES = modelArtifact.trees as TreeJson[];
const INIT = modelArtifact.init as number;
const LR = modelArtifact.learning_rate as number;
const FEATURE_MEANS = modelArtifact.feature_means as number[];

export function timeFeatures(tick: number): [number, number] {
  const angle = (2 * Math.PI * (tick % DAY_CYCLE_TICKS)) / DAY_CYCLE_TICKS;
  return [Math.sin(angle), Math.cos(angle)];
}

export function buildFeatureVector(
  history: number[],
  tick: number,
  incident: boolean,
  neighborAvg: number,
): number[] {
  const padded = [0, 0, 0, ...history].slice(-3);
  const [sin, cos] = timeFeatures(tick);
  return [padded[2], padded[1], padded[0], sin, cos, incident ? 1 : 0, neighborAvg];
}

function walkTree(tree: TreeJson, x: number[]): number {
  let n = 0;
  while (tree.l[n] !== -1) n = x[tree.f[n]] <= tree.t[n] ? tree.l[n] : tree.r[n];
  return tree.v[n];
}

function rawPredict(x: number[]): number {
  let total = 0;
  for (const tree of TREES) total += walkTree(tree, x);
  return INIT + LR * total;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

export interface PredictionResult {
  segment_id: string;
  current_occupancy: number;
  predicted_occupancy: number;
  horizon_ticks: number;
  risk_level: "low" | "moderate" | "high";
  top_factor: string;
  top_factor_contribution: number;
  explanation: string;
  model?: string;
  centralized_reference?: number;
}

const EXPLANATIONS: Record<string, (v: number) => string> = {
  lag1: (v) => `Recent occupancy trend (${v.toFixed(2)}) is climbing.`,
  lag2: (v) => `Occupancy two ticks ago (${v.toFixed(2)}) shows sustained buildup.`,
  lag3: (v) => `A short-term occupancy trend (${v.toFixed(2)}) is driving the forecast.`,
  time_sin: () => "Diurnal rush-hour phase is the dominant driver.",
  time_cos: () => "Diurnal rush-hour phase is the dominant driver.",
  incident_flag: () => "An active incident on this segment is the dominant driver.",
  neighbor_avg: (v) => `Congestion pressure from neighbouring segments (${v.toFixed(2)}) is spilling over.`,
};

export class CongestionPredictor {
  buildFeatures(seg: Segment, tick: number, neighborAvg?: number): number[] {
    return buildFeatureVector(
      seg.history.slice(-3),
      tick,
      seg.confirmedIncident,
      neighborAvg ?? seg.occupancy,
    );
  }

  predict(seg: Segment, tick: number, neighborAvg?: number, explain = true): PredictionResult {
    const feats = this.buildFeatures(seg, tick, neighborAvg);
    const predicted = clamp01(rawPredict(feats));
    const risk = predicted > 0.75 ? "high" : predicted > 0.5 ? "moderate" : "low";

    const base: PredictionResult = {
      segment_id: seg.id,
      current_occupancy: round3(seg.occupancy),
      predicted_occupancy: round3(predicted),
      horizon_ticks: PREDICTION_HORIZON_TICKS,
      risk_level: risk,
      top_factor: "",
      top_factor_contribution: 0,
      explanation: "",
    };
    if (!explain) return base;

    // Occlusion attribution: how much would the forecast move if this feature
    // were at its dataset-typical value? That is what drove *this* prediction,
    // unlike a global importance score.
    let bestIdx = 0;
    let bestMag = -1;
    let bestContribution = 0;
    for (let i = 0; i < FEATURE_DIM; i++) {
      const perturbed = [...feats];
      perturbed[i] = FEATURE_MEANS[i];
      const contribution = predicted - clamp01(rawPredict(perturbed));
      if (Math.abs(contribution) > bestMag) {
        bestMag = Math.abs(contribution);
        bestIdx = i;
        bestContribution = contribution;
      }
    }
    const name = FEATURE_NAMES[bestIdx];
    return {
      ...base,
      top_factor: name,
      top_factor_contribution: round3(bestContribution),
      explanation: EXPLANATIONS[name](feats[bestIdx]),
    };
  }
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;

// ------------------------------------------------------- M7 federated
const FLOAT_BYTES = 4;
const RAW_SAMPLE_BYTES = (FEATURE_DIM + 1) * FLOAT_BYTES + 24;
const LOCAL_EPOCHS = 4;
const LEARNING_RATE = 0.03;
const MIN_SAMPLES_PER_ROUND = 12;
const BUFFER_LIMIT = 400;

export interface Weights {
  w: number[];
  b: number;
}

const zeroWeights = (): Weights => ({ w: new Array(FEATURE_DIM).fill(0), b: 0 });

function predictLinear(weights: Weights, x: number[]): number {
  let acc = weights.b;
  for (let i = 0; i < FEATURE_DIM; i++) acc += weights.w[i] * x[i];
  return acc;
}

export class FederatedClient {
  weights: Weights = zeroWeights();
  samplesContributed = 0;
  roundsJoined = 0;
  lastDrift = 0;
  private buffer: { x: number[]; y: number }[] = [];

  constructor(readonly rsuId: string) {}

  get pendingSamples() {
    return this.buffer.length;
  }

  /** Local observations stay here permanently — never uploaded. */
  observe(x: number[], y: number) {
    this.buffer.push({ x, y });
    if (this.buffer.length > BUFFER_LIMIT) this.buffer.shift();
  }

  localTrain(): { weights: Weights; n: number } | null {
    if (this.buffer.length < MIN_SAMPLES_PER_ROUND) return null;
    const n = this.buffer.length;
    const w = [...this.weights.w];
    let b = this.weights.b;

    for (let epoch = 0; epoch < LOCAL_EPOCHS; epoch++) {
      const grad = new Array(FEATURE_DIM).fill(0);
      let gradB = 0;
      for (const { x, y } of this.buffer) {
        const err = predictLinear({ w, b }, x) - y;
        for (let i = 0; i < FEATURE_DIM; i++) grad[i] += err * x[i];
        gradB += err;
      }
      for (let i = 0; i < FEATURE_DIM; i++) w[i] -= (LEARNING_RATE * grad[i]) / n;
      b -= (LEARNING_RATE * gradB) / n;
    }

    this.weights = { w, b };
    this.samplesContributed += n;
    this.roundsJoined += 1;
    return { weights: { w: [...w], b }, n };
  }

  /** Adopt the aggregated model, recording how far local training had drifted
   *  from it first — the mobility-induced divergence the literature warns
   *  about. Matches the Python `ModelWeights.distance_to`: L2 on the weight
   *  vector plus the absolute intercept gap. */
  loadGlobal(global: Weights) {
    let sq = 0;
    for (let i = 0; i < FEATURE_DIM; i++) sq += (this.weights.w[i] - global.w[i]) ** 2;
    this.lastDrift = Math.sqrt(sq) + Math.abs(this.weights.b - global.b);
    this.weights = { w: [...global.w], b: global.b };
    this.buffer = [];
  }

  predictOne(x: number[]) {
    return clamp01(predictLinear(this.weights, x));
  }
}

export interface RoundSummary {
  round: number;
  tick: number;
  participants: string[];
  client_count: number;
  samples_used: number;
  global_loss: number;
  loss_delta: number;
  weights_kilobytes: number;
  raw_kilobytes_avoided: number;
  avg_client_drift: number;
}

export class FederatedCoordinator {
  globalWeights: Weights = zeroWeights();
  rounds: RoundSummary[] = [];
  initialLoss: number;
  private lastLoss: number;
  private readonly Xv = valset.X as number[][];
  private readonly yv = valset.y as number[];

  constructor() {
    this.initialLoss = this.loss(this.globalWeights);
    this.lastLoss = this.initialLoss;
  }

  private loss(weights: Weights): number {
    let total = 0;
    for (let i = 0; i < this.yv.length; i++) {
      const p = clamp01(predictLinear(weights, this.Xv[i]));
      total += (p - this.yv[i]) ** 2;
    }
    return total / this.yv.length;
  }

  /** FedAvg: the aggregator sees weights and sample counts, nothing else. */
  runRound(clients: FederatedClient[], tick: number): RoundSummary | null {
    const uploads: { id: string; weights: Weights; n: number }[] = [];
    for (const c of clients) {
      const trained = c.localTrain();
      if (trained) uploads.push({ id: c.rsuId, weights: trained.weights, n: trained.n });
    }
    if (!uploads.length) return null;

    const total = uploads.reduce((s, u) => s + u.n, 0);
    const w = new Array(FEATURE_DIM).fill(0);
    let b = 0;
    for (const u of uploads) {
      const share = u.n / total;
      for (let i = 0; i < FEATURE_DIM; i++) w[i] += u.weights.w[i] * share;
      b += u.weights.b * share;
    }
    this.globalWeights = { w, b };

    const drifts: number[] = [];
    const ids = new Set(uploads.map((u) => u.id));
    for (const c of clients)
      if (ids.has(c.rsuId)) {
        c.loadGlobal(this.globalWeights);
        drifts.push(c.lastDrift);
      }

    const loss = this.loss(this.globalWeights);
    const summary: RoundSummary = {
      round: this.rounds.length + 1,
      tick,
      participants: uploads.map((u) => u.id),
      client_count: uploads.length,
      samples_used: total,
      global_loss: round6(loss),
      loss_delta: round6(loss - this.lastLoss),
      weights_kilobytes: ((FEATURE_DIM + 1) * FLOAT_BYTES * uploads.length * 2) / 1024,
      raw_kilobytes_avoided: (total * RAW_SAMPLE_BYTES) / 1024,
      avg_client_drift: drifts.length ? drifts.reduce((a, x) => a + x, 0) / drifts.length : 0,
    };
    this.lastLoss = loss;
    this.rounds.push(summary);
    if (this.rounds.length > 200) this.rounds.shift();
    return summary;
  }

  convergenceRound(fraction = 0.25): number | null {
    if (this.initialLoss <= 0) return null;
    const target = this.initialLoss * fraction;
    return this.rounds.find((r) => r.global_loss <= target)?.round ?? null;
  }

  snapshot() {
    const latest = this.rounds[this.rounds.length - 1] ?? null;
    return {
      rounds_completed: this.rounds.length,
      initial_loss: round6(this.initialLoss),
      current_loss: round6(this.lastLoss),
      loss_reduction_pct: this.initialLoss
        ? Math.round((1 - this.lastLoss / this.initialLoss) * 10000) / 100
        : 0,
      convergence_round: this.convergenceRound(),
      total_weights_kilobytes: round3(this.rounds.reduce((s, r) => s + r.weights_kilobytes, 0)),
      total_raw_kilobytes_avoided:
        Math.round(this.rounds.reduce((s, r) => s + r.raw_kilobytes_avoided, 0) * 10) / 10,
      latest_round: latest,
      history: this.rounds.slice(-60),
      weights: {
        features: FEATURE_NAMES,
        coefficients: this.globalWeights.w.map((v) => Math.round(v * 10000) / 10000),
        intercept: Math.round(this.globalWeights.b * 10000) / 10000,
      },
    };
  }
}

const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
