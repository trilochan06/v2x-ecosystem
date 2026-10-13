import type { FederatedState, SimulationState } from "../types";

function LossChart({ fl }: { fl: FederatedState }) {
  const rounds = fl.history;
  if (rounds.length < 2) return null;
  const w = 220;
  const h = 56;
  const all = rounds.flatMap((r) => [r.global_loss, r.plain_loss]);
  const lo = Math.min(...all);
  const hi = Math.max(...all);
  const span = hi - lo || 1;
  const path = (pick: (r: (typeof rounds)[number]) => number) =>
    rounds
      .map((r, i) => `${(i / (rounds.length - 1)) * w},${h - ((pick(r) - lo) / span) * h}`)
      .join(" ");

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="fl-chart" preserveAspectRatio="none">
      <polyline points={path((r) => r.plain_loss)} fill="none" stroke="#64748b" strokeWidth={1.4} strokeDasharray="5 4" />
      <polyline points={path((r) => r.global_loss)} fill="none" stroke="#38bdf8" strokeWidth={1.8} />
    </svg>
  );
}

export function FederatedPanel({ state }: { state: SimulationState }) {
  const fl: FederatedState | undefined = state.federated;
  if (!fl) return null;

  const latest = fl.latest_round;
  const savedKb = fl.total_raw_bytes_avoided / 1024;
  const sentKb = fl.total_weights_bytes / 1024;
  const ratio = sentKb > 0 ? savedKb / sentKb : 0;
  const trustBeatsPlain = fl.skill > fl.plain_skill;

  return (
    <div className="panel">
      <h2>Federated Learning</h2>
      <p className="muted small">
        Every RSU trains a congestion model on the roads it actually covers and uploads parameters, never samples. A
        round runs every {fl.round_interval} ticks.
      </p>

      {fl.rounds_completed === 0 ? (
        <p className="muted small">Waiting for the first round &mdash; each unit needs a minimum buffer before it trains.</p>
      ) : (
        <>
          <div className="fl-grid">
            <div>
              <span className="fl-figure">{fl.rounds_completed}</span>
              <span className="muted small">rounds</span>
            </div>
            <div>
              <span className="fl-figure">{fl.skill >= 0 ? "+" : ""}{fl.skill.toFixed(2)}</span>
              <span className="muted small">skill vs mean</span>
            </div>
            <div>
              <span className="fl-figure">{fl.current_loss.toFixed(4)}</span>
              <span className="muted small">holdout loss</span>
            </div>
            <div>
              <span className="fl-figure">{ratio.toFixed(0)}&times;</span>
              <span className="muted small">less on the wire</span>
            </div>
          </div>

          <LossChart fl={fl} />
          <p className="muted small fl-legend">
            <i className="line" style={{ background: "#38bdf8" }} /> trust-weighted aggregate &nbsp;
            <i className="line dashed" /> plain FedAvg, same uploads
          </p>

          <p className="small">
            {savedKb.toFixed(1)} KB of raw observations stayed on the roadside; {sentKb.toFixed(1)} KB of parameters
            crossed the network.
          </p>

          <p className="small">
            Skill is measured against predicting the holdout mean, because the holdout is a sliding window over a
            city that starts empty, so raw loss drifts upward even when the model is improving.
          </p>

          <p className="small">
            Against the shadow aggregated from the same uploads, trust weighting is{" "}
            <strong>{trustBeatsPlain ? "ahead" : "behind"}</strong> ({fl.skill.toFixed(3)} vs{" "}
            {fl.plain_skill.toFixed(3)}). With attackers spread evenly across cells every unit's source trust is
            similar, so the two rules pick nearly the same weights; the margin only opens up when corruption is
            concentrated in one neighbourhood.
          </p>

          {latest && latest.excluded.length > 0 && (
            <p className="fl-excluded small">
              Excluded below the {fl.participation_floor} trust floor: {latest.excluded.join(", ")}
            </p>
          )}

          <h3 className="fl-subhead">Participating units</h3>
          <div className="fl-clients">
            {fl.clients.map((c) => (
              <div key={c.rsu_id} className={`fl-client ${c.eligible ? "" : "excluded"}`}>
                <span>{c.rsu_id}</span>
                <span className="muted">{c.buffered_samples} buffered</span>
                <span className="muted">trust {c.data_trust.toFixed(2)}</span>
                <span className="muted">drift {c.drift.toFixed(3)}</span>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
