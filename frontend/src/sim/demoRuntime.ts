/**
 * The street-level simulator.
 *
 * The control centre shows a whole city at a glance: twenty-six vehicles, six
 * roadside units, and numbers that only mean something in aggregate. That is
 * the right view for measuring, and the wrong one for *understanding* — you
 * cannot follow any individual car, and the radio traffic that is the entire
 * point of V2X is invisible.
 *
 * This runs the same engine over a deliberately small scene: a four-by-four
 * neighbourhood, a handful of vehicles, and nothing happening unless you make
 * it happen. It is slow enough to watch, pausable, and steppable one tick at a
 * time — which is what it takes to actually see a hazard being noticed by one
 * car, gossiped to its neighbours, and confirmed by a roadside unit.
 */
import { useEffect, useState } from "react";
import { CONFIGS, SimulationEngine } from "./engine";
import type { SimulationState } from "../types";

/** Small enough that every vehicle is followable. */
export const DEMO_GRID_SIZE = 4;
export const DEMO_RSU_COUNT = 4;
export const DEMO_VEHICLE_COUNT = 6;

/** Tick intervals, slowest first. The default is deliberately unhurried. */
export const SPEEDS = [
  { label: "0.5×", ms: 1600 },
  { label: "1×", ms: 900 },
  { label: "2×", ms: 450 },
  { label: "4×", ms: 220 },
] as const;

export const DEFAULT_SPEED_INDEX = 1;

function build(seed: number): SimulationEngine {
  return new SimulationEngine({
    gridSize: DEMO_GRID_SIZE,
    numRsus: DEMO_RSU_COUNT,
    numVehicles: DEMO_VEHICLE_COUNT,
    config: CONFIGS.exp3_full,
    seed,
    // Nothing happens unless the user asks for it. A demo that spawns random
    // hazards while you are explaining something is a demo that fights you.
    autoHazards: false,
    inferenceInterval: 2,
    explainPredictions: true,
  });
}

let engine = build(Math.floor(Math.random() * 1e9));
const listeners = new Set<(s: SimulationState) => void>();
let timer: number | undefined;
let playing = false;
let speedIndex = DEFAULT_SPEED_INDEX;

function publish() {
  const snapshot = engine.stateSnapshot();
  for (const listener of listeners) listener(snapshot);
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

export const demo = {
  get playing() {
    return playing;
  },
  get speedIndex() {
    return speedIndex;
  },

  play() {
    playing = true;
    startTimer();
    publish();
  },

  pause() {
    playing = false;
    clearTimer();
    publish();
  },

  /** One tick, then stop. The most useful control on the page. */
  stepOnce() {
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

  reset(seed = Math.floor(Math.random() * 1e9)) {
    clearTimer();
    playing = false;
    engine = build(seed);
    publish();
  },

  // --- things the user can make happen -------------------------------
  injectHazard: (segmentId?: string) => {
    const id = engine.injectHazard(segmentId);
    publish();
    return id;
  },
  spawnVehicle: () => {
    const v = engine.spawnVehicle("car");
    publish();
    return v.id;
  },
  spawnAmbulance: () => {
    const v = engine.spawnVehicle("ambulance");
    publish();
    return v.id;
  },
  spawnAttacker: () => {
    const v = engine.spawnVehicle("malicious");
    publish();
    return v.id;
  },
  setCloud: (online: boolean) => {
    engine.setCloudOnline(online);
    publish();
  },
  toggleRsu: (rsuId: string, alive: boolean) => {
    engine.toggleRsu(rsuId, alive);
    publish();
  },
};

export function useDemo() {
  const [state, setState] = useState<SimulationState | null>(null);
  const [, force] = useState(0);

  useEffect(() => {
    const listener = (s: SimulationState) => {
      setState(s);
      // playing/speed live outside React state, so nudge a re-render when a
      // publish happens for any reason.
      force((n) => n + 1);
    };
    listeners.add(listener);
    // Resume where the user left it: navigating to another tab and back
    // should not lose a running scene, but nor should it have run on without
    // them while nobody was looking.
    if (playing) startTimer();
    listener(engine.stateSnapshot());

    return () => {
      listeners.delete(listener);
      // Nobody is watching: stop burning CPU on a scene no one can see.
      // `playing` is deliberately left set so remounting picks it back up.
      if (listeners.size === 0) clearTimer();
    };
  }, []);

  return { state, playing, speedIndex };
}
