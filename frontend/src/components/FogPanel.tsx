import type { SimulationState } from "../types";

export function FogPanel({ state }: { state: SimulationState }) {
  return (
    <div className="panel">
      <h2>Fog Computing Layer</h2>
      <p className="muted small">
        Regional tier between edge RSUs and the cloud. Each cluster aggregates its member RSUs' digests into one
        summary and raises a regional alert when a whole district -- not just a single intersection -- is jamming up.
      </p>
      <div className="fog-cluster-list">
        {state.fog_nodes.map((fog) => (
          <div key={fog.id} className={`fog-cluster ${fog.alert ? "alert" : ""}`}>
            <div className="fog-cluster-header">
              <span>{fog.id}</span>
              {fog.alert && <span className="fog-badge">REGIONAL ALERT</span>}
            </div>
            <div className="fog-cluster-body">
              <span className="muted">{fog.member_rsu_ids.join(", ")}</span>
              <span>{(fog.avg_occupancy * 100).toFixed(0)}% avg occupancy</span>
              <span className="muted">{fog.vehicles_served} vehicles &middot; {fog.incident_count} incident(s)</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
