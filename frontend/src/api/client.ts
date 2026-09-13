import type { ExperimentSuite, FederatedState, ReferenceData, Scenario, ArchitectureConfigState } from "../types";

const API = "/api";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(`${API}${path}`);
  if (!res.ok) throw new Error(`GET ${path} failed: ${res.status}`);
  return res.json();
}

async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`POST ${path} failed: ${res.status}`);
  return res.json();
}

export const api = {
  reference: () => get<ReferenceData>("/reference"),
  federated: () => get<FederatedState>("/federated"),
  scenarios: () => get<{ scenarios: Scenario[]; configs: ArchitectureConfigState[] }>("/experiments/scenarios"),
  runExperiments: (scenario: string, ticks: number, seed: number) =>
    post<ExperimentSuite>("/experiments/run", { scenario, ticks, seed }),
  architectures: () => get<{ configs: ArchitectureConfigState[]; active: string }>("/architecture/configs"),
  switchArchitecture: (key: string) => post<{ active: string; label: string }>("/architecture/switch", { key }),
};

export const commands = {
  spawnAmbulance: () => post("/emergency/spawn"),
  spawnMalicious: () => post("/malicious/spawn"),
  spawnVehicle: () => post("/vehicles/spawn"),
  injectHazard: () => post("/hazards"),
  replayAttack: () => post<{ attempted: number; blocked: number }>("/attacks/replay"),
  toggleRsu: (rsuId: string, alive: boolean) => post(`/faults/rsu/${rsuId}/toggle`, { alive }),
  setCloud: (online: boolean) => post("/faults/cloud", { online }),
};
