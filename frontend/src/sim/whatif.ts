/**
 * Ask the twin a question before asking the city.
 *
 * A digital twin that only mirrors is a monitoring dashboard with extra
 * steps. The thing a replica can do that the road cannot is be experimented
 * on: close a street in the model, see what the model says happens, and only
 * then decide whether to close the street.
 *
 * The forecast is not a second traffic simulator. It runs the *shipped*
 * congestion model — the same gradient-boosted trees serving every prediction
 * on the site — over the replica twice: once on the state as synced, once on
 * the state as the intervention would leave it. The difference between those
 * two forecasts is the predicted impact. Using the project's own model rather
 * than a formula invented for this panel means the what-if is only as good as
 * the model, which is the honest place for its accuracy to come from.
 *
 * Every result carries the twin's divergence and staleness with it, because a
 * forecast from a replica is worth exactly what the replica is worth, and
 * that number is already measured.
 */
import { CongestionPredictor } from "./ai";
import type { DigitalTwin } from "./agents";
import type { CityGrid, Segment } from "./core";
import { roadName } from "./core";

export type Intervention =
  | { kind: "close_road"; segmentId: string }
  | { kind: "accident"; segmentId: string }
  | { kind: "rain" }
  | { kind: "fog" };

export interface WhatIfRoad {
  segmentId: string;
  road: string;
  before: number;
  after: number;
  delta: number;
}

export interface WhatIfResult {
  intervention: Intervention;
  label: string;
  /** What the model is forecasting over, in ticks. */
  horizonTicks: number;
  baselineMeanOccupancy: number;
  predictedMeanOccupancy: number;
  deltaMeanOccupancy: number;
  baselineCongested: number;
  predictedCongested: number;
  /** The worst single road, before and after.
   *
   *  Reported beside the mean because for a closure the mean is actively
   *  misleading: taking one road's traffic and spreading it over the roads
   *  that meet it lowers the average while raising the peak, so a change that
   *  concentrates pressure somewhere can look like an improvement. The peak
   *  is what a junction actually fails at. */
  baselineWorst: number;
  predictedWorst: number;
  /** Roads the intervention moves most, worst first. */
  roads: WhatIfRoad[];
  /** How much to trust the above. */
  confidence: {
    divergenceAtForecast: number;
    stalenessTicks: number;
    note: string;
  };
}

/** Occupancy at or above this counts a road as congested. Matches the twin's
 *  own `congested_segments` figure so the two numbers agree. */
const CONGESTED = 0.7;

/**
 * What rain does to density.
 *
 * Greenshields again: wet roads cut free-flow speed, and the same flow of
 * vehicles travelling slower sits at a higher density. It does not conjure
 * extra traffic — it makes the traffic already there take up more road.
 */
const RAIN_DENSITY_FACTOR = 1.25;
const FOG_DENSITY_FACTOR = 1.4;
/** A blocked lane does not delete its traffic; it pushes it onto the roads
 *  that meet it. */
const REDISTRIBUTION_SHARE = 0.75;
/** What a crash takes out of the lane it sits in, over and above the queue
 *  behind it. Matches CRASH_LANE_BLOCKAGE in the live engine. */
const ACCIDENT_BLOCKAGE = 0.25;

export const INTERVENTION_LABEL = (i: Intervention): string => {
  switch (i.kind) {
    case "close_road":
      return `Close ${roadName(i.segmentId)}`;
    case "accident":
      return `Accident on ${roadName(i.segmentId)}`;
    case "rain":
      return "Heavy rain across the city";
    case "fog":
      return "Fog across the city";
  }
};

function forecast(
  segments: Segment[],
  grid: CityGrid,
  predictor: CongestionPredictor,
  tick: number,
): Map<string, number> {
  const byId = new Map(segments.map((s) => [s.id, s]));
  const out = new Map<string, number>();
  for (const seg of segments) {
    // Neighbour pressure is part of what the model reads, so it has to be
    // computed over the shadow set rather than the live roads — otherwise the
    // intervention's effect on a road's neighbours never reaches it.
    const neighbours = grid
      .adjacentSegments(seg)
      .map((n) => byId.get(n.id)?.occupancy ?? n.occupancy);
    const neighbourAvg = neighbours.length
      ? neighbours.reduce((a, b) => a + b, 0) / neighbours.length
      : seg.occupancy;
    out.set(seg.id, predictor.predict(seg, tick, neighbourAvg, false).predicted_occupancy);
  }
  return out;
}

/**
 * Put a road into a given state, in the terms the model actually reads.
 *
 * The congestion model is fitted on occupancy *lags*, not on a current
 * reading — `buildFeatures` passes `history.slice(-3)` and never looks at
 * `occupancy` at all. So setting `occupancy` alone changes a field the
 * forecast ignores, and the whole what-if silently predicts no effect
 * whatever the intervention. The lags are the state as far as the model is
 * concerned, so an intervention has to be written there.
 *
 * How far back it is written matters. A closure or a crash is an event that
 * has just happened, so only the most recent lag carries it and the model
 * still sees the road's ordinary history behind it. Weather has been falling
 * for a while by the time anyone acts on it, so it colours the whole window.
 */
function setState(seg: Segment, occupancy: number, lags: number) {
  const value = Math.max(0, Math.min(1, occupancy));
  seg.occupancy = value;
  if (!seg.history.length) seg.history = [value];
  else for (let i = 1; i <= Math.min(lags, seg.history.length); i++) seg.history[seg.history.length - i] = value;
}

/** Apply the intervention to a copy of the replica. */
function intervene(segments: Segment[], grid: CityGrid, intervention: Intervention): Segment[] {
  const byId = new Map(segments.map((s) => [s.id, s]));

  if (intervention.kind === "rain" || intervention.kind === "fog") {
    const factor = intervention.kind === "rain" ? RAIN_DENSITY_FACTOR : FOG_DENSITY_FACTOR;
    for (const seg of segments) setState(seg, seg.occupancy * factor, 3);
    return segments;
  }

  const target = byId.get(intervention.segmentId);
  if (!target) return segments;

  const neighbours = grid.adjacentSegments(target).map((n) => byId.get(n.id) ?? n);
  const displaced = target.occupancy * REDISTRIBUTION_SHARE;

  if (intervention.kind === "close_road") {
    // A closed road is not a free road: it is a road nobody can use, and its
    // traffic has to go somewhere. Marking it confirmed is what makes the
    // forecast treat it as known-blocked rather than mysteriously empty.
    setState(target, 0, 1);
    target.confirmedIncident = true;
  } else {
    setState(target, target.occupancy + ACCIDENT_BLOCKAGE, 1);
    target.confirmedIncident = true;
  }

  if (neighbours.length) {
    const each = displaced / neighbours.length;
    for (const n of neighbours) setState(n, n.occupancy + each, 1);
  }
  return segments;
}

export function runWhatIf(
  twin: DigitalTwin,
  grid: CityGrid,
  predictor: CongestionPredictor,
  tick: number,
  intervention: Intervention,
  horizonTicks: number,
): WhatIfResult {
  const baselineSegments = twin.replicaSegments();
  const baseline = forecast(baselineSegments, grid, predictor, tick + horizonTicks);

  // A second, independent copy: `intervene` mutates, and reusing the first
  // would have the baseline quietly measured against itself.
  const changed = intervene(twin.replicaSegments(), grid, intervention);
  const predicted = forecast(changed, grid, predictor, tick + horizonTicks);

  const roads: WhatIfRoad[] = [];
  let baseSum = 0;
  let predSum = 0;
  let baseCongested = 0;
  let predCongested = 0;
  let baseWorst = 0;
  let predWorst = 0;

  for (const [id, before] of baseline) {
    const after = predicted.get(id) ?? before;
    baseSum += before;
    predSum += after;
    if (before >= CONGESTED) baseCongested += 1;
    if (after >= CONGESTED) predCongested += 1;
    baseWorst = Math.max(baseWorst, before);
    predWorst = Math.max(predWorst, after);
    const delta = after - before;
    // Low threshold on purpose. Displaced traffic divides across every road
    // meeting the closed one, so each neighbour's share is small even when
    // the redistribution is the whole point; a coarser cutoff hid it and left
    // the closure looking like it had deleted the traffic.
    if (Math.abs(delta) >= 0.004)
      roads.push({
        segmentId: id,
        road: roadName(id),
        before: Math.round(before * 1000) / 1000,
        after: Math.round(after * 1000) / 1000,
        delta: Math.round(delta * 1000) / 1000,
      });
  }

  roads.sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta));
  const n = baseline.size || 1;
  const round3 = (v: number) => Math.round(v * 1000) / 1000;
  const divergence = twin.divergence();
  const staleness = twin.lastSyncTick < 0 ? 0 : tick - twin.lastSyncTick;

  // Rounded once, then differenced, so the three figures the panel shows are
  // arithmetically consistent. Rounding each independently produces a delta
  // that does not equal the gap between the two numbers printed beside it.
  const baseMean = round3(baseSum / n);
  const predMean = round3(predSum / n);

  return {
    intervention,
    label: INTERVENTION_LABEL(intervention),
    horizonTicks,
    baselineMeanOccupancy: baseMean,
    predictedMeanOccupancy: predMean,
    deltaMeanOccupancy: round3(predMean - baseMean),
    baselineCongested: baseCongested,
    predictedCongested: predCongested,
    baselineWorst: round3(baseWorst),
    predictedWorst: round3(predWorst),
    roads: roads.slice(0, 8),
    confidence: {
      divergenceAtForecast: round3(divergence),
      stalenessTicks: staleness,
      note:
        divergence > 0.12
          ? "The replica has drifted from the road. Treat this forecast as indicative only."
          : "The replica is tracking the road closely, so the forecast rests on current state.",
    },
  };
}
