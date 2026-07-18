import { useState } from "react";
import type { SimulationState } from "../types";
import { commands } from "../api/commands";

export function ControlConsole({ state }: { state: SimulationState }) {
  const [busy, setBusy] = useState<string | null>(null);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    try {
      await fn();
    } catch (err) {
      console.error(err);
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="panel">
      <h2>Control Console</h2>
      <div className="control-buttons">
        <button disabled={busy !== null} onClick={() => run("amb", commands.spawnAmbulance)}>
          Dispatch Ambulance
        </button>
        <button disabled={busy !== null} onClick={() => run("mal", commands.spawnMalicious)}>
          Inject Malicious Vehicle
        </button>
        <button disabled={busy !== null} onClick={() => run("veh", commands.spawnVehicle)}>
          Spawn Vehicle
        </button>
      </div>
      <h3>RSU Fault Injection</h3>
      <div className="rsu-toggle-list">
        {state.rsus.map((rsu) => (
          <button
            key={rsu.id}
            disabled={busy !== null}
            className={rsu.alive ? "rsu-btn alive" : "rsu-btn down"}
            onClick={() => run(rsu.id, () => commands.toggleRsu(rsu.id, !rsu.alive))}
          >
            {rsu.id} &middot; {rsu.alive ? "alive" : "DOWN"}
          </button>
        ))}
      </div>
    </div>
  );
}
