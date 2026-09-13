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
  if (timer !== undefined) return;
  timer = window.setInterval(() => {
    engine.step();
    publish();
  }, TICK_INTERVAL_MS);
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
    };
  }, []);

  return { state, connected: true };
}

export const commands = {
  spawnVehicle: () => {
    engine.spawnVehicle("car");
    publish();
  },
  spawnAmbulance: () => {
    engine.spawnVehicle("ambulance");
    publish();
  },
  spawnMalicious: () => {
    engine.spawnVehicle("malicious");
    publish();
  },
  injectHazard: () => {
    engine.injectHazard();
    publish();
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
