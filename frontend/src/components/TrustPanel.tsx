import type { SimulationState } from "../types";

export function TrustPanel({ state }: { state: SimulationState }) {
  const entries = Object.entries(state.trust)
    .filter(([, v]) => v.reports_seen > 0)
    .sort((a, b) => a[1].trust_score - b[1].trust_score)
    .slice(0, 8);

  return (
    <div className="panel">
      <h2>Trust &amp; Security</h2>
      {entries.length === 0 && <p className="muted">No hazard reports observed yet.</p>}
      <table className="trust-table">
        <thead>
          <tr>
            <th>Node</th>
            <th>Trust</th>
            <th>Seen</th>
            <th>Confirmed</th>
          </tr>
        </thead>
        <tbody>
          {entries.map(([id, t]) => (
            <tr key={id} className={t.quarantined ? "quarantined" : ""}>
              <td>{id}</td>
              <td>{t.trust_score.toFixed(2)}</td>
              <td>{t.reports_seen}</td>
              <td>{t.reports_corroborated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
