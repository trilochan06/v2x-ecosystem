/**
 * The guided demo's engine and its story state.
 *
 * Separate from `demoRuntime` on purpose. That one is a free-play sandbox
 * where nothing happens unless you make it happen; this one is a presenter's
 * tool that stages a specific event and then tracks whether the system
 * actually did the things the story claims it does.
 *
 * The beats are watched, never asserted. If a scenario says an ambulance will
 * be granted priority and the request is lost on the air, that beat stays
 * dark — which is the truthful way to demonstrate a lossy radio, and far more
 * convincing than a scripted animation that always succeeds.
 */
import { useEffect, useState } from "react";
import { CONFIGS, SimulationEngine } from "./engine";
import { ALL_SCENARIOS, baselineOf, type Baseline, type Scenario } from "./scenarios";
import type { SimulationState } from "../types";

/** Small enough to follow every car, dense enough in roadside units that an
 *  ambulance usually meets a signalised junction on its way. */
export const GUIDED_GRID_SIZE = 4;
export const GUIDED_RSU_COUNT = 9;
/**
 * Enough traffic that corroboration has something to work with.
 *
 * This was seven, which looked tidier and made the headline crash story fail
 * about one run in six: a report needs a second, independent witness before
 * the network will believe it, and on an empty grid there is nobody to be
 * that witness. Twelve is still sparse enough to follow every car
 * individually, and takes every story to 24 of 24 seeds — see
 * `scenarios.test.ts`, which measures it rather than asserting it.
 */
export const GUIDED_VEHICLE_COUNT = 12;

/** Deliberately unhurried. A demo you cannot narrate over is a demo nobody
 *  understands. */
export const SPEEDS = [
  { label: "Slow", ms: 1400 },
  { label: "Normal", ms: 800 },
  { label: "Fast", ms: 380 },
] as const;

export const DEFAULT_SPEED_INDEX = 1;

export interface StoryState {
  scenario: Scenario | null;
  /** Beat index -> the tick it became true, or null while still pending. */
  achieved: (number | null)[];
  startedTick: number;
  /** Roughly how long the story runs, used only to flag the long one. */
  ticks: number;
  finished: boolean;
  /** The runtime stopped the clock because the story reached its end. */
  pausedOnFinish: boolean;
}

function build(seed: number): SimulationEngine {
  return new SimulationEngine({
    gridSize: GUIDED_GRID_SIZE,
    numRsus: GUIDED_RSU_COUNT,
    numVehicles: GUIDED_VEHICLE_COUNT,
    config: CONFIGS.exp3_full,
    seed,
    // Random hazards would interrupt the story being told.
    autoHazards: false,
    inferenceInterval: 2,
    explainPredictions: true,
  });
}

let engine = build(Math.floor(Math.random() * 1e9));
let scenario: Scenario | null = null;
let baseline: Baseline | null = null;
let achieved: (number | null)[] = [];
let startedTick = 0;
let pausedOnFinish = false;

const listeners = new Set<() => void>();
let timer: number | undefined;
let playing = false;
let speedIndex = DEFAULT_SPEED_INDEX;
let snapshot: SimulationState = engine.stateSnapshot();

function story(): StoryState {
  return {
    scenario,
    achieved: [...achieved],
    startedTick,
    ticks: scenario?.ticks ?? 0,
    // Optional beats genuinely may not fire, so they must not hold the story
    // open forever — but a required beat that never lands should.
    finished:
      Boolean(scenario) &&
      (scenario?.beats ?? []).every((beat, i) => beat.optional || achieved[i] !== null),
    pausedOnFinish,
  };
}

/** Check every pending beat against the live state and latch the ones that
 *  have become true. Latching matters: a beat like "a car is braking" is only
 *  momentarily true, and a checklist that un-ticks itself is unreadable. */
function latchBeats() {
  if (!scenario || !baseline) return;
  const wasFinished = story().finished;
  scenario.beats.forEach((beat, i) => {
    if (achieved[i] !== null) return;
    let hit = false;
    try {
      hit = beat.done(snapshot, baseline!);
    } catch {
      // A predicate that throws is a bug in the story, not a reason to take
      // the whole page down mid-demo.
      hit = false;
    }
    if (hit) achieved[i] = snapshot.tick;
  });

  // Freeze on the payoff. These cascades finish in a handful of ticks — the
  // crash story is done by tick 3 — so left running, the scene the checklist
  // is describing has scrolled away before anyone can look at it.
  if (!wasFinished && story().finished && playing) {
    playing = false;
    clearTimer();
    pausedOnFinish = true;
  }
}

function publish() {
  snapshot = engine.stateSnapshot();
  latchBeats();
  for (const listener of listeners) listener();
}

function clearTimer() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

function startTimer() {
  clearTimer();
  timer = window.setInterval(() => {
    engine.step();
    publish();
  }, SPEEDS[speedIndex].ms);
}

export const guided = {
  get playing() {
    return playing;
  },
  get speedIndex() {
    return speedIndex;
  },
  get state() {
    return snapshot;
  },
  get story() {
    return story();
  },

  play() {
    pausedOnFinish = false;
    playing = true;
    startTimer();
    publish();
  },

  pause() {
    playing = false;
    clearTimer();
    publish();
  },

  stepOnce() {
    pausedOnFinish = false;
    playing = false;
    clearTimer();
    engine.step();
    publish();
  },

  setSpeed(index: number) {
    speedIndex = Math.max(0, Math.min(index, SPEEDS.length - 1));
    if (playing) startTimer();
    publish();
  },

  /**
   * Begin a story: snapshot the world as it stands, stage the event, and
   * start watching for the beats.
   */
  runScenario(id: string) {
    const next = ALL_SCENARIOS.find((s) => s.id === id);
    if (!next) return;
    scenario = next;
    baseline = baselineOf(engine.stateSnapshot());
    achieved = next.beats.map(() => null);
    startedTick = engine.tick;
    pausedOnFinish = false;
    next.setup(engine);
    playing = true;
    startTimer();
    publish();
  },

  /** Drop the story but leave the city running. */
  clearScenario() {
    scenario = null;
    baseline = null;
    achieved = [];
    publish();
  },

  /** Fresh city, fresh story. */
  reset(seed = Math.floor(Math.random() * 1e9)) {
    clearTimer();
    playing = false;
    engine = build(seed);
    scenario = null;
    baseline = null;
    achieved = [];
    startedTick = 0;
    pausedOnFinish = false;
    publish();
  },
};

export function useGuided() {
  const [, force] = useState(0);

  useEffect(() => {
    const listener = () => force((n) => n + 1);
    listeners.add(listener);
    // Pick the scene back up where the viewer left it rather than restarting
    // it, but never let it run on while nobody is watching.
    if (playing) startTimer();
    listener();

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) clearTimer();
    };
  }, []);

  return { state: snapshot, story: story(), playing, speedIndex };
}
