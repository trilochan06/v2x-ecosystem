import { useState } from "react";
import { commands, switchArchitecture, useSimulation } from "../sim/runtime";
import { CONFIGS } from "../sim/engine";
import { CityMap } from "../components/CityMap";
import { ExplainPanel } from "../components/ExplainPanel";
import { EventLog } from "../components/EventLog";
import { FogPanel } from "../components/FogPanel";
import type { ArchitectureConfigState, SimulationState } from "../types";

export function ControlCenter() {
  const { state, connected } = useSimulation();
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  const configs: ArchitectureConfigState[] = Object.values(CONFIGS);
  const busy = false;

  const run = (fn: () => unknown) => fn();

  if (!state) {
    return (
      <div className="loading">
        <p>Connecting to the simulation engine…</p>
        <p className="muted small">The simulation runs in your browser — no server required.</p>
      </div>
    );
  }

  const m = state.metrics;

  return (
    <div className="control">
      <div className="page-head">
        <div>
          <h1>Live control centre</h1>
          <p className="muted">
            {state.config.label} · tick {state.tick} ·{" "}
            <span className={connected ? "status ok" : "status bad"}>{connected ? "LIVE" : "RECONNECTING"}</span>
          </p>
        </div>
        <div className="arch-switch">
          <label htmlFor="arch">Architecture</label>
          <select
            id="arch"
            value={state.config.key}
            disabled={busy}
            onChange={(e) => switchArchitecture(e.target.value)}
          >
            {configs.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="statbar">
        <Stat label="Vehicles" value={state.vehicles.length} />
        <Stat label="RSUs down" value={state.rsus.filter((r) => !r.alive).length} warn={state.rsus.some((r) => !r.alive)} />
        <Stat label="Cloud" value={state.cloud_online ? "online" : "OUT"} warn={!state.cloud_online} />
        <Stat label="Hazards live" value={state.segments.filter((s) => s.hazard_active).length} />
        <Stat label="Confirmed" value={state.segments.filter((s) => s.confirmed_incident).length} />
        <Stat label="Alert latency" value={`${m.communication.avg_alert_latency_ticks}t`} />
        <Stat label="PDR" value={m.communication.packet_delivery_ratio.toFixed(2)} />
        <Stat label="Uplink" value={`${m.communication.uplink_kilobytes_per_tick} KB/t`} />
        <Stat label="Detection F1" value={m.detection.f1.toFixed(2)} />
        <Stat label="V2V reroutes" value={state.total_reroutes} />
      </div>

      <div className="control-body">
        <section className="map-panel">
          <CityMap state={state} selectedSegment={selectedSegment} onSelectSegment={setSelectedSegment} />
          <div className="legend">
            <span><i className="dot" style={{ background: "#7dd3fc" }} /> vehicle</span>
            <span><i className="dot" style={{ background: "#f87171" }} /> ambulance</span>
            <span><i className="dot" style={{ background: "#c084fc" }} /> attacker</span>
            <span><i className="line" style={{ background: "#199e70" }} /> free flowing</span>
            <span><i className="line" style={{ background: "#e66767" }} /> congested</span>
            <span><i className="line dashed-red" /> physical hazard</span>
            <span><i className="line dashed-amber" /> network-confirmed incident</span>
          </div>
        </section>

        <aside className="side">
          <div className="panel">
            <h2>Scenario controls</h2>
            <div className="btn-col">
              <button disabled={busy} onClick={() => run(commands.injectHazard)}>Inject road hazard</button>
              <button disabled={busy} onClick={() => run(commands.spawnAmbulance)}>Dispatch ambulance</button>
              <button disabled={busy} onClick={() => run(commands.spawnMalicious)}>Inject attacker</button>
              <button disabled={busy} onClick={() => run(commands.spawnVehicle)}>Add vehicle</button>
              <button
                disabled={busy}
                className={state.cloud_online ? "" : "danger"}
                onClick={() => run(() => commands.setCloud(!state.cloud_online))}
              >
                {state.cloud_online ? "Sever cloud uplink" : "Restore cloud uplink"}
              </button>
            </div>
            <h3>RSU fault injection</h3>
            <div className="rsu-grid">
              {state.rsus.map((rsu) => (
                <button
                  key={rsu.id}
                  disabled={busy}
                  className={rsu.alive ? "rsu-btn" : "rsu-btn down"}
                  onClick={() => run(() => commands.toggleRsu(rsu.id, !rsu.alive))}
                >
                  {rsu.id} · {rsu.alive ? "up" : "DOWN"}
                </button>
              ))}
            </div>
          </div>

          <ExplainPanel state={state} selectedSegment={selectedSegment} />
          <FogPanel state={state} />

          <div className="panel">
            <h2>Digital twin (M8)</h2>
            <dl className="kv">
              <div><dt>Syncs</dt><dd>{state.digital_twin.syncs}</dd></div>
              <div><dt>Staleness</dt><dd>{state.digital_twin.staleness_ticks} ticks</dd></div>
              <div><dt>Divergence</dt><dd>{state.digital_twin.divergence}</dd></div>
              <div><dt>Synced</dt><dd>{state.digital_twin.kilobytes_synced} KB</dd></div>
            </dl>
            <p className="muted small">
              Divergence is the mean gap between the replica and the physical road state. It grows whenever
              synchronization is disabled or the uplink is severed.
            </p>
          </div>

          <MessageMix state={state} />
          <EventLog state={state} />
        </aside>
      </div>
    </div>
  );
}

/** What is actually on the air, by standard. The mix is the interesting part
 *  of the overhead story — a cloud-only config shows probe traffic and no
 *  C-ITS frames at all, which is the whole argument in one panel. */
function MessageMix({ state }: { state: SimulationState }) {
  const frames = state.metrics.communication.frames_by_designator;
  const kilobytes = state.metrics.communication.kilobytes_by_designator;
  const rows = Object.entries(frames).sort((a, b) => b[1] - a[1]);
  const total = rows.reduce((sum, [, n]) => sum + n, 0);

  return (
    <div className="panel">
      <h2>Message mix (ETSI C-ITS)</h2>
      {rows.length === 0 ? (
        <p className="muted small">No frames transmitted yet.</p>
      ) : (
        <table className="data-table">
          <thead>
            <tr>
              <th>Frame</th>
              <th>Standard</th>
              <th>Count</th>
              <th>Share</th>
              <th>KB</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([designator, count]) => (
              <tr key={designator}>
                <td>{designator}</td>
                <td className="muted small">{DESIGNATOR_STANDARD[designator] ?? "—"}</td>
                <td>{count}</td>
                <td>{total ? Math.round((count / total) * 100) : 0}%</td>
                <td>{kilobytes[designator] ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="muted small">
        CAM is the periodic awareness heartbeat, DENM the event-driven hazard warning carrying a
        CauseCode from the TS 102 894-2 dictionary. “probe” is not a C-ITS message at all — it is
        the raw telemetry stream a cloud-only architecture depends on.
      </p>
    </div>
  );
}

const DESIGNATOR_STANDARD: Record<string, string> = {
  CAM: "EN 302 637-2",
  DENM: "EN 302 637-3",
  probe: "non-standard backhaul",
};

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={warn ? "stat warn" : "stat"}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
