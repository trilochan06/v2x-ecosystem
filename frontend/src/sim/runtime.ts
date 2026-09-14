/** The live engine instance + React binding.
 *
 * This replaces the WebSocket the earlier build used. The simulation now runs
 * in the browser, so the site is a static bundle with no backend to deploy —
 * and the UI contract is unchanged: `stateSnapshot()` emits exactly the shape
 * the pages already consume.
 */
import { useEffect, useState } from "react";
import { CONFIGS, SimulationEngine } from "./engine";
import type { SimulationState } from "../types";

export const TICK_INTERVAL_MS = 800;

let engine = new SimulationEngine({ seed: Math.floor(Math.random() * 1e9) });
const listeners = new Set<(s: SimulationState) => void>();
let timer: number | undefined;

function publish() {
  const snapshot = engine.stateSnapshot();
  for (const listener of listeners) listener(snapshot);
}

function ensureTicking() {
  if (timer !== undefined || listeners.size === 0) return;
  timer = window.setInterval(() => {
    engine.step();
    publish();
  }, TICK_INTERVAL_MS);
}

/** Stop the clock when no page is displaying this engine. */
function stopTicking() {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
}

export function getEngine() {
  return engine;
}

/** Swap the live architecture — this is what the control centre's dropdown
 *  does, and it is how you watch the centralized baseline behave differently
 *  on the same map. */
export function switchArchitecture(key: string) {
  const config = CONFIGS[key];
  if (!config) return;
  engine = new SimulationEngine({ config, seed: Math.floor(Math.random() * 1e9) });
  publish();
}

export function useSimulation() {
  const [state, setState] = useState<SimulationState | null>(null);

  useEffect(() => {
    const listener = (s: SimulationState) => setState(s);
    listeners.add(listener);
    ensureTicking();
    listener(engine.stateSnapshot()); // paint immediately, don't wait a tick
    return () => {
      listeners.delete(listener);
      // The city is only "live" while someone is looking at it. Ticking an
      // unobserved engine is pure waste, and with the street-view engine also
      // running it was two of them.
      if (listeners.size === 0) stopTicking();
    };
  }, []);

  return { state, connected: true };
}

/**
 * Every command reports what it actually did.
 *
 * The controls always worked, but a new car is one dot among twenty-six and
 * an injected hazard lands on a random road — so from the outside nothing
 * appeared to happen. Returning the affected id lets the UI name it and put
 * the map on it.
 */
export const commands = {
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
  spawnMalicious: () => {
    const v = engine.spawnVehicle("malicious");
    publish();
    return v.id;
  },
  injectHazard: () => {
    const segmentId = engine.injectHazard();
    publish();
    return segmentId;
  },
  replayAttack: () => {
    const result = engine.injectReplayAttack();
    publish();
    return result;
  },
  toggleRsu: (rsuId: string, alive: boolean) => {
    engine.toggleRsu(rsuId, alive);
    publish();
  },
  setCloud: (online: boolean) => {
    engine.setCloudOnline(online);
    publish();
  },
};
