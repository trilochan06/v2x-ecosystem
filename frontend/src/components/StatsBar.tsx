import type { SimulationState } from "../types";

export function StatsBar({ state, connected }: { state: SimulationState; connected: boolean }) {
  const avgTrust =
    Object.values(state.trust).reduce((sum, t) => sum + t.trust_score, 0) / Math.max(1, Object.keys(state.trust).length);
  const quarantined = Object.values(state.trust).filter((t) => t.quarantined).length;
  const incidentCount = state.segments.filter((s) => s.incident).length;
  const downRsus = state.rsus.filter((r) => !r.alive).length;

  return (
    <div className="stats-bar">
      <div className={`ws-indicator ${connected ? "connected" : ""}`}>{connected ? "LIVE" : "RECONNECTING"}</div>
      <Stat label="Tick" value={state.tick} />
      <Stat label="Vehicles" value={state.vehicles.length} />
      <Stat label="RSUs down" value={downRsus} warn={downRsus > 0} />
      <Stat label="Msgs/tick" value={state.messages_this_tick} />
      <Stat label="Active incidents" value={incidentCount} warn={incidentCount > 0} />
      <Stat label="Quarantined nodes" value={quarantined} warn={quarantined > 0} />
      <Stat label="Avg trust" value={avgTrust.toFixed(2)} />
      <Stat label="Active corridors" value={state.active_corridors.length} warn={state.active_corridors.length > 0} />
      <Stat label="Fog clusters" value={state.fog_nodes.length} />
      <Stat
        label="Regional alerts"
        value={state.fog_nodes.filter((f) => f.alert).length}
        warn={state.fog_nodes.some((f) => f.alert)}
      />
      <Stat label="V2V reroutes (total)" value={state.total_reroutes} />
    </div>
  );
}

function Stat({ label, value, warn }: { label: string; value: string | number; warn?: boolean }) {
  return (
    <div className={`stat ${warn ? "warn" : ""}`}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
