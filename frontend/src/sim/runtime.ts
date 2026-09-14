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

/**
 * How many vehicles the live city starts with.
 *
 * It used to be 26, which measures perfectly well and reads terribly: at that
 * density the map is a field of dots and you cannot follow anything. The
 * experiment suite sets its own counts per scenario, so this number only
 * affects what the control centre shows, and the density control below lets
 * the viewer put it back up.
 */
export const DEFAULT_VEHICLE_COUNT = 14;

/** Traffic densities offered on the control centre, sparsest first. */
export const DENSITIES = [
  { label: "Quiet", vehicles: 8 },
  { label: "Normal", vehicles: DEFAULT_VEHICLE_COUNT },
  { label: "Busy", vehicles: 22 },
  { label: "Rush hour", vehicles: 34 },
] as const;

/**
 * Ticks run before anybody looks, so no page is ever born empty.
 *
 * Without this the engine starts at tick 0 wherever you land, and the pages
 * that read aggregate state have nothing to show: Federated Learning rendered
 * a grid of zeros for a measured 36 seconds before its first round landed,
 * which reads as a broken page rather than a young one. Federated rounds are
 * every 15 ticks, incidents need corroboration, and trust needs a history — so
 * the city arrives already having lived a little.
 *
 * 90 ticks costs ~70 ms once at startup and yields several federated rounds,
 * confirmed incidents and reroutes.
 */
const WARM_UP_TICKS = 90;

function buildEngine(config = CONFIGS.exp3_full, vehicles = DEFAULT_VEHICLE_COUNT) {
  const next = new SimulationEngine({
    config,
    seed: Math.floor(Math.random() * 1e9),
    numVehicles: vehicles,
  });
  for (let i = 0; i < WARM_UP_TICKS; i++) next.step();
  return next;
}

let engine = buildEngine();
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
  // Warmed too, or switching architecture would blank every page that reads
  // aggregate state.
  engine = buildEngine(config, engine.vehicles.size || DEFAULT_VEHICLE_COUNT);
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
  spawnPedestrian: () => {
    const id = engine.spawnPedestrian();
    publish();
    return id ? (engine.pedestrians.get(id)?.segmentId ?? null) : null;
  },
  /** Thin the traffic out or pack it in. The map is only readable at a
   *  density the viewer chose. */
  setVehicleCount: (target: number) => {
    engine.setVehicleCount(target);
    publish();
    return engine.vehicles.size;
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
