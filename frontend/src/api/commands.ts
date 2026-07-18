const API_BASE = "/api";

async function post(path: string, body?: unknown) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} failed: ${res.status}`);
  return res.json();
}

export const commands = {
  spawnAmbulance: () => post("/emergency/spawn"),
  spawnMalicious: () => post("/malicious/spawn"),
  spawnVehicle: () => post("/vehicles/spawn"),
  toggleRsu: (rsuId: string, alive: boolean) => post(`/faults/rsu/${rsuId}/toggle`, { alive }),
  markIncident: (segmentId: string) => post(`/incidents/${segmentId}`),
};
