import type { DigitalTwinState, SimulationState, TwinAnomaly } from "../types";

const ANOMALY_LABEL: Record<TwinAnomaly["kind"], string> = {
  unmodelled_incident: "real hazard the network never confirmed",
  phantom_incident: "confirmed incident that was never real",
  occupancy_drift: "replica drifted from the road",
};

function Sparkline({ values, threshold }: { values: number[]; threshold: number }) {
  if (values.length < 2) return null;
  const w = 220;
  const h = 34;
  const max = Math.max(threshold * 1.4, ...values);
  const pts = values
    .map((v, i) => `${(i / (values.length - 1)) * w},${h - (v / max) * h}`)
    .join(" ");
  const ty = h - (threshold / max) * h;
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="twin-spark" preserveAspectRatio="none">
      <line x1={0} y1={ty} x2={w} y2={ty} stroke="#f97316" strokeWidth={1} strokeDasharray="4 4" opacity={0.7} />
      <polyline points={pts} fill="none" stroke="#38bdf8" strokeWidth={1.6} />
    </svg>
  );
}

export function TwinPanel({ state }: { state: SimulationState }) {
  const twin: DigitalTwinState | undefined = state.digital_twin;
  const det = state.detection;
  if (!twin) return null;

  return (
    <div className="panel">
      <h2>Transportation Digital Twin</h2>
      <p className="muted small">
        A replica of every road, refreshed every {twin.sync_interval} ticks from what the network believes &mdash; not
        from the simulator. It publishes how old it is and how far it has drifted from physical reality, because a copy
        whose error is unknown cannot safely be reasoned about.
      </p>

      <div className={`twin-grid ${twin.alert ? "alert" : ""}`}>
        <div>
          <span className="twin-figure">{twin.staleness_ticks}</span>
          <span className="muted small">ticks stale</span>
        </div>
        <div>
          <span className="twin-figure">{twin.divergence.toFixed(3)}</span>
          <span className="muted small">mean divergence</span>
        </div>
        <div>
          <span className="twin-figure">{twin.max_segment_gap.toFixed(2)}</span>
          <span className="muted small">worst segment</span>
        </div>
        <div>
          <span className="twin-figure">{twin.replica_segments}</span>
          <span className="muted small">roads mirrored</span>
        </div>
      </div>

      <Sparkline values={twin.divergence_history} threshold={twin.alert_threshold} />
      {twin.alert && (
        <p className="twin-alert">
          Divergence is past {twin.alert_threshold}. The replica is no longer authoritative &mdash; something is
          happening on the road that the model does not represent.
        </p>
      )}

      {det && (
        <>
          <h3 className="twin-subhead">Belief against truth</h3>
          <p className="muted small">
            The network can never read the physical hazard flag, so these are real measurements rather than a
            comparison of a quantity with itself.
          </p>
          <div className="twin-detection">
            <span>
              precision <strong>{det.precision.toFixed(2)}</strong>
            </span>
            <span>
              recall <strong>{det.recall.toFixed(2)}</strong>
            </span>
            <span className="muted">
              {det.true_positives} confirmed &middot; {det.false_positives} false &middot; {det.false_negatives} missed
            </span>
          </div>
        </>
      )}

      {twin.anomalies.length > 0 && (
        <>
          <h3 className="twin-subhead">What the twin cannot explain</h3>
          <ul className="twin-anomalies">
            {twin.anomalies.slice(0, 6).map((a, i) => (
              <li key={`${a.tick}-${a.segment_id}-${i}`}>
                <span className="muted">t{a.tick}</span> {a.segment_id} &mdash; {ANOMALY_LABEL[a.kind]}
                {a.kind === "occupancy_drift" && <span className="muted"> (gap {a.gap.toFixed(2)})</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
