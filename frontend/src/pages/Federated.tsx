import { useSimulation } from "../sim/runtime";
import { ConvergenceLine } from "../components/charts/ConvergenceLine";

export function Federated() {
  const { state } = useSimulation();

  if (!state) {
    return <div className="loading">Connecting to the simulation engine…</div>;
  }

  const fed = state.federated;
  const enabled = state.config.federated_learning;
  const savingRatio =
    fed.total_weights_kilobytes > 0
      ? fed.total_raw_kilobytes_avoided / fed.total_weights_kilobytes
      : 0;

  const points = fed.history.map((r) => ({
    x: r.round,
    y: r.global_loss,
    meta: `${r.client_count} RSUs · ${r.samples_used} samples`,
  }));

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Federated learning (M7)</h1>
          <p className="muted">
            RSUs train on what they observe and upload weights only. No vehicle observation ever leaves the edge node
            that collected it.
          </p>
        </div>
      </div>

      {!enabled && (
        <div className="notice">
          Federated learning is disabled in <strong>{state.config.label}</strong>. Switch to the full architecture on the
          control centre to watch rounds run.
        </div>
      )}

      <div className="statbar">
        <Stat label="Rounds completed" value={fed.rounds_completed} />
        <Stat label="Loss reduction" value={`${fed.loss_reduction_pct}%`} />
        <Stat label="Converged at round" value={fed.convergence_round ?? "—"} />
        <Stat label="Weights exchanged" value={`${fed.total_weights_kilobytes.toFixed(2)} KB`} />
        <Stat label="Raw data avoided" value={`${fed.total_raw_kilobytes_avoided.toFixed(0)} KB`} />
        <Stat label="Bandwidth ratio" value={savingRatio > 0 ? `${savingRatio.toFixed(0)}×` : "—"} />
      </div>

      <section className="panel wide">
        <ConvergenceLine
          title="Global model loss by federated round"
          yLabel="validation MSE"
          xLabel="federated round"
          points={points}
          target={
            fed.initial_loss > 0
              ? { value: fed.initial_loss * 0.25, label: "convergence target (25% of initial)" }
              : undefined
          }
        />
        <p className="muted small">
          Loss is measured on a held-out synthetic corpus the clients never train on. The aggregator sees weight vectors
          and sample counts — never a single observation — so this curve is produced without any raw telemetry being
          centralised.
        </p>
      </section>

      <div className="two-col">
        <section className="panel">
          <h2>Participating edge clients</h2>
          <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>RSU</th>
                <th>Rounds</th>
                <th>Samples</th>
                <th>Pending</th>
                <th>Drift</th>
              </tr>
            </thead>
            <tbody>
              {state.rsus.map((rsu) => (
                <tr key={rsu.id} className={rsu.alive ? "" : "muted-row"}>
                  <td>
                    {rsu.id} {!rsu.alive && <span className="pill bad">down</span>}
                  </td>
                  <td>{rsu.fl.rounds_joined}</td>
                  <td>{rsu.fl.samples_contributed}</td>
                  <td>{rsu.fl.pending_samples}</td>
                  <td>{rsu.fl.drift}</td>
                </tr>
              ))}
            </tbody>
          </table>
          </div>
          <p className="muted small">
            Drift is how far a client's locally trained weights had moved from the global model before the last
            aggregation — the divergence the literature flags for highly mobile nodes.
          </p>
        </section>

        <section className="panel">
          <h2>Global model</h2>
          <p className="muted small">
            A linear congestion forecaster, so federated averaging is exactly the sample-weighted mean of the clients'
            parameters and can be checked by hand.
          </p>
          <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Feature</th>
                <th>Weight</th>
              </tr>
            </thead>
            <tbody>
              {fed.weights.features.map((f, i) => (
                <tr key={f}>
                  <td>{f}</td>
                  <td>{fed.weights.coefficients[i]}</td>
                </tr>
              ))}
              <tr>
                <td>
                  <em>intercept</em>
                </td>
                <td>{fed.weights.intercept}</td>
              </tr>
            </tbody>
          </table>
          </div>
        </section>
      </div>

      <section className="panel wide">
        <h2>Trust-weighted aggregation</h2>
        <p className="muted">
          Plain FedAvg weights each roadside unit purely by how much data it has — which is the
          wrong instinct when some of that data came from vehicles the network does not believe.
          The busiest compromised RSU would get the loudest vote. Here each training sample is
          believed in proportion to the corroboration-derived trust of the vehicle that reported
          it, and a client whose sources fall below the floor is excluded from the round outright.
          This is the one place M11 (security) feeds M7 (learning).
        </p>
        <div className="statbar">
          <Stat label="Trust-weighted loss" value={fed.current_loss.toFixed(5)} />
          <Stat label="Plain FedAvg would be" value={fed.plain_fedavg_loss.toFixed(5)} />
          <Stat
            label="Difference"
            value={`${fed.trust_weighting_gain_pct >= 0 ? "+" : ""}${fed.trust_weighting_gain_pct}%`}
          />
          <Stat label="Mean source trust" value={fed.mean_client_trust.toFixed(3)} />
          <Stat label="Rounds with exclusions" value={fed.rounds_with_exclusions} />
        </div>
        <p className="muted small">
          Both models are aggregated every round from the same client updates, so the comparison is
          like-for-like. Read it honestly: with no attackers present the two are within noise of
          each other, which is the correct outcome — the defence should cost nothing when there is
          nothing to defend against. Inject attackers on the Control Centre and watch mean source
          trust fall. Across five seeds the measured benefit under attack was +0.31% and under
          heavy attack the variance swamped it, so this is reported as a mechanism that works as
          specified rather than as a demonstrated win.
        </p>
      </section>

      <section className="panel wide">
        <h2>Why this is the privacy argument, concretely</h2>
        <div className="two-col">
          <div>
            <h3>Centralized training</h3>
            <p className="muted">
              Every observation — position, segment, speed, timestamp — is uploaded so the cloud can fit a model on the
              pooled data. That upload is both the bandwidth cost and the privacy exposure: the pooled set is a movement
              history of every participating vehicle.
            </p>
          </div>
          <div>
            <h3>Federated training</h3>
            <p className="muted">
              The same model is fitted without any of that leaving the roadside. Each round moves{" "}
              {fed.latest_round ? fed.latest_round.weights_kilobytes.toFixed(3) : "~0.05"} KB of weights instead of{" "}
              {fed.latest_round ? fed.latest_round.raw_kilobytes_avoided.toFixed(1) : "several"} KB of raw samples, and
              the aggregator never holds a record of where any vehicle has been.
            </p>
          </div>
        </div>
      </section>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div className="stat">
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
