import { useState } from "react";
import { DENSITIES, commands, switchArchitecture, useSimulation } from "../sim/runtime";
import { CONFIGS } from "../sim/engine";
import { CityMap } from "../components/CityMap";
import { ExplainPanel } from "../components/ExplainPanel";
import { EventLog } from "../components/EventLog";
import { FogPanel } from "../components/FogPanel";
import { Toaster } from "../components/Toaster";
import { useToaster } from "../components/useToaster";
import type { ArchitectureConfigState, SimulationState } from "../types";

export function ControlCenter() {
  const { state, connected } = useSimulation();
  const [selectedSegment, setSelectedSegment] = useState<string | null>(null);
  /** Hide the side column and give the map the whole page. The map is the
   *  thing people came to look at; at 1fr next to a 360px column on a laptop
   *  it is too small to read. */
  const [wideMap, setWideMap] = useState(false);
  const configs: ArchitectureConfigState[] = Object.values(CONFIGS);
  const busy = false;
  const { toasts, push, dismiss } = useToaster();

  // Name what happened and put the map on it, so a click is visibly a click.
  const readable = (segmentId: string) => segmentId.replace("_", " \u2192 ");

  const onInjectHazard = () => {
    const segmentId = commands.injectHazard();
    if (!segmentId) {
      push("Every road already has a hazard on it.", "warn");
      return;
    }
    setSelectedSegment(segmentId);
    push(`Hazard injected on ${readable(segmentId)} — watch it turn amber when peers corroborate it.`, "warn");
  };

  const onPedestrian = () => {
    const segmentId = commands.spawnPedestrian();
    if (!segmentId) {
      push("No crossing with traffic on it right now.", "warn");
      return;
    }
    setSelectedSegment(segmentId);
    push(
      `Pedestrian on ${readable(segmentId)} — the car that can see them brakes and shares them over CPM, ` +
        `so cars with no line of sight slow too.`,
      "warn",
    );
  };

  const onSpawn = (kind: "car" | "ambulance" | "malicious") => {
    const id =
      kind === "car"
        ? commands.spawnVehicle()
        : kind === "ambulance"
          ? commands.spawnAmbulance()
          : commands.spawnMalicious();
    const blurb = {
      car: `Vehicle ${id} joined the network.`,
      ambulance: `Ambulance ${id} dispatched — it will request priority at each signal ahead.`,
      malicious: `Attacker ${id} joined — watch its trust fall on the Security page.`,
    }[kind];
    push(blurb, kind === "malicious" ? "bad" : kind === "ambulance" ? "good" : "info");
  };

  const onToggleCloud = () => {
    const online = !state?.cloud_online;
    commands.setCloud(online);
    push(
      online
        ? "Cloud uplink restored."
        : "Cloud uplink severed — the edge keeps operating. Switch to Exp 1 and try again to see the difference.",
      online ? "good" : "warn",
    );
  };

  const onToggleRsu = (rsuId: string, alive: boolean) => {
    commands.toggleRsu(rsuId, alive);
    push(
      alive ? `${rsuId} restored.` : `${rsuId} knocked out — its vehicles will re-home to a neighbour.`,
      alive ? "good" : "warn",
    );
  };

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
        {state.signal_priority.requested > 0 && (
          <Stat
            label="Signal priority"
            value={`${state.signal_priority.grant_rate_pct}%`}
            warn={state.signal_priority.grant_rate_pct < 80}
          />
        )}
        {/* Collective perception: cars warned about someone they cannot see. */}
        {state.perception.shared > 0 && (
          <Stat label="Warned unsighted" value={state.perception.warned_blind} />
        )}
      </div>

      <div className={wideMap ? "control-body wide" : "control-body"}>
        <section className="map-panel">
          <div className="map-tools">
            <div className="density" role="group" aria-label="Traffic density">
              <span className="density-label">Traffic</span>
              {DENSITIES.map((d) => (
                <button
                  key={d.label}
                  className={state.vehicles.length === d.vehicles ? "chip active" : "chip"}
                  onClick={() => {
                    const n = commands.setVehicleCount(d.vehicles);
                    push(`${d.label} — ${n} vehicles on the map.`, "info");
                  }}
                >
                  {d.label}
                </button>
              ))}
            </div>
            <button className="chip" onClick={() => setWideMap((w) => !w)}>
              {wideMap ? "⇤ Show panels" : "⇥ Widen map"}
            </button>
          </div>
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
          {/* The feed is the running record of what every control did, so it
              belongs above the fold rather than below four other panels. */}
          <EventLog state={state} />

          <div className="panel">
            <h2>Scenario controls</h2>
            <div className="btn-col">
              <button disabled={busy} onClick={onInjectHazard}>Inject road hazard</button>
              <button disabled={busy} onClick={onPedestrian}>Pedestrian on a crossing</button>
              <button disabled={busy} onClick={() => onSpawn("ambulance")}>Dispatch ambulance</button>
              <button disabled={busy} onClick={() => onSpawn("malicious")}>Inject attacker</button>
              <button disabled={busy} onClick={() => onSpawn("car")}>Add vehicle</button>
              <button
                disabled={busy}
                className={state.cloud_online ? "" : "danger"}
                onClick={onToggleCloud}
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
                  onClick={() => onToggleRsu(rsu.id, !rsu.alive)}
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

          {state.signal_priority.requested > 0 && (
            <div className="panel">
              <h2>Signal priority (SREM / SSEM)</h2>
              <dl className="kv">
                <div><dt>Requested</dt><dd>{state.signal_priority.requested}</dd></div>
                <div><dt>Granted</dt><dd>{state.signal_priority.granted}</dd></div>
                <div><dt>Never heard</dt><dd>{state.signal_priority.unheard}</dd></div>
                <div><dt>Grant rate</dt><dd>{state.signal_priority.grant_rate_pct}%</dd></div>
              </dl>
              <p className="muted small">
                An ambulance asks each intersection ahead for priority with an SREM and the
                junction answers with an SSEM. Because the ask travels over a lossy radio it can
                go unheard — a direct function call could not, which is exactly why the corridor
                used to look perfectly reliable.
              </p>
            </div>
          )}

          <MessageMix state={state} />
        </aside>
      </div>

      <Toaster toasts={toasts} dismiss={dismiss} />
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
