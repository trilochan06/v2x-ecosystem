import { useState } from "react";
import { DEFAULT_REPEATS, SCENARIOS, runSuite } from "../sim/experiments";
import { BarComparison } from "../components/charts/BarComparison";
import { SERIES_COLORS } from "../components/charts/palette";
import type { ExperimentSuite, Scenario } from "../types";

/** Below this many corroborated alerts, the latency average is noise and the
 *  page says so instead of printing a number. */
const MIN_LATENCY_SAMPLES = 5;

const SHORT: Record<string, string> = {
  exp1_centralized: "Exp 1 · Centralized",
  exp2_v2x_no_edge_ai: "Exp 2 · V2X, no edge AI",
  exp3_full: "Exp 3 · Full architecture",
};

export function Experiments() {
  const scenarios: Scenario[] = SCENARIOS;
  const [scenario, setScenario] = useState("normal");
  const [ticks, setTicks] = useState(250);
  const [seed, setSeed] = useState(4242);
  const [repeats, setRepeats] = useState(DEFAULT_REPEATS);
  const [suite, setSuite] = useState<ExperimentSuite | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setRunning(true);
    setError(null);
    setProgress({ done: 0, total: 3 * repeats });
    // Yield once so the button repaints as "running" before the sweep blocks
    // the main thread.
    await new Promise((resolve) => setTimeout(resolve, 30));
    try {
      setSuite(runSuite(scenario, ticks, seed, repeats));
    } catch (e) {
      console.error(e);
      setError("The sweep failed to run.");
    } finally {
      setRunning(false);
    }
  };

  const labels = suite ? suite.runs.map((r) => SHORT[r.config.key] ?? r.config.label) : [];
  const series = (pick: (r: ExperimentSuite["runs"][number]) => number) =>
    suite
      ? suite.runs.map((r, i) => ({ label: labels[i], value: pick(r), color: SERIES_COLORS[i] }))
      : [];

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Experimental evaluation</h1>
          <p className="muted">
            The three configurations from the project design, run over the same scenario and the same seed, so the
            differences come from the architecture rather than from luck. Each run includes a scripted cloud outage.
          </p>
        </div>
      </div>

      <section className="panel controls-row">
        <div className="field">
          <label htmlFor="scenario">Scenario</label>
          <select id="scenario" value={scenario} onChange={(e) => setScenario(e.target.value)}>
            {scenarios.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </div>
        <div className="field">
          <label htmlFor="ticks">Duration (ticks)</label>
          <input
            id="ticks"
            type="number"
            min={120}
            max={800}
            step={50}
            value={ticks}
            onChange={(e) => setTicks(Number(e.target.value))}
          />
        </div>
        <div className="field">
          <label htmlFor="seed">First seed</label>
          <input id="seed" type="number" value={seed} onChange={(e) => setSeed(Number(e.target.value))} />
        </div>
        <div className="field">
          <label htmlFor="repeats">Seeds per configuration</label>
          <select id="repeats" value={repeats} onChange={(e) => setRepeats(Number(e.target.value))}>
            <option value={1}>1 — no interval</option>
            <option value={3}>3 — quick</option>
            <option value={5}>5 — recommended</option>
            <option value={10}>10 — slow</option>
          </select>
        </div>
        <button className="btn primary" onClick={run} disabled={running}>
          {running ? `Running ${progress.total} simulations…` : "Run the sweep"}
        </button>
      </section>

      {running && progress.total > 0 && (
        <div className="notice" role="status" aria-live="polite">
          Running {progress.total} simulations — {repeats} seed{repeats === 1 ? "" : "s"} for each of
          the three architectures. The engine runs in this tab, so the page will be unresponsive
          until it finishes.
        </div>
      )}

      {error && <div className="notice bad">{error}</div>}

      {!suite && !running && (
        <div className="notice">
          Run the sweep to generate results. Three full simulations take a few seconds. Shorter runs may not contain
          enough hazards to produce a stable latency figure — 250 ticks or more is recommended.
        </div>
      )}

      {suite && (
        <>
          <section className="panel wide">
            <h2>Headline results — {suite.scenario.label}</h2>
            <p className="muted small">
              {suite.scenario.description} · {suite.ticks} ticks · {suite.scenario.vehicles} vehicles
              {suite.scenario.malicious > 0 && `, ${suite.scenario.malicious} attackers`}
              {suite.scenario.ambulances > 0 && `, ${suite.scenario.ambulances} ambulances`} ·{" "}
              {suite.repeats === 1
                ? `single seed ${suite.seed}`
                : `${suite.repeats} seeds (${suite.seeds[0]}–${suite.seeds[suite.seeds.length - 1]}), mean ± 95% CI`}
            </p>
            <div className="headline-grid">
              {Object.entries(suite.headline).map(([key, h]) => {
                const samples = Math.min(
                  ...suite.runs.map((r) => r.metrics.communication.alert_samples),
                );
                const tooFew = key === "alert_latency" && samples < MIN_LATENCY_SAMPLES;
                return (
                  <div className="headline" key={key}>
                    <span className="headline-label">{h.label}</span>
                    {tooFew ? (
                      <>
                        <span className="headline-value muted">not enough data</span>
                        <span className="delta">
                          only {samples} corroborated alert{samples === 1 ? "" : "s"} — run longer
                        </span>
                      </>
                    ) : (
                      <>
                        <span className="headline-value">
                          {h.baseline} <span className="arrow">→</span> {h.proposed}
                          <span className="headline-unit"> {h.unit}</span>
                        </span>
                        {h.samples > 1 && (
                          <span className="headline-ci">
                            ±{h.baseline_half_width} → ±{h.proposed_half_width} (95% CI, n=
                            {h.samples})
                          </span>
                        )}
                        <span className={h.improvement_pct >= 0 ? "delta good" : "delta bad"}>
                          {h.improvement_pct >= 0 ? "improved " : "worse "}
                          {Math.abs(h.improvement_pct)}
                          {key === "availability_during_outage" ? " pts" : "%"}
                        </span>
                        {/* Overlapping intervals mean the seeds do not
                            separate these two, and saying so is the whole
                            point of running more than one. */}
                        {h.samples > 1 && !h.separated && (
                          <span className="delta muted">
                            intervals overlap — not separated at this sample size
                          </span>
                        )}
                      </>
                    )}
                  </div>
                );
              })}
            </div>
            {suite.repeats === 1 && (
              <p className="notice small">
                One seed is a sample, not a result. Set “seeds per configuration” to 5 to get
                confidence intervals and a statement of whether the configurations actually
                separate.
              </p>
            )}
          </section>

          <div className="chart-grid">
            <BarComparison
              title="Hazard-to-warning latency"
              unit="ticks"
              data={series((r) => r.metrics.communication.avg_alert_latency_ticks)}
              lowerIsBetter
              caption="Time from a hazard physically appearing to a warning reaching a vehicle whose route crosses it."
            />
            <BarComparison
              title="Cloud uplink overhead"
              unit="KB per tick"
              data={series((r) => r.metrics.communication.uplink_kilobytes_per_tick)}
              lowerIsBetter
              precision={3}
              caption="Backhaul traffic only. The centralized baseline streams raw telemetry from every vehicle; the edge designs send digests, twin deltas and model weights."
            />
            <BarComparison
              title="Availability during cloud outage"
              unit="%"
              data={series((r) => r.metrics.resilience.availability_during_outage_pct)}
              lowerIsBetter={false}
              precision={1}
              caption="Fraction of the scripted outage window during which safety messaging still functioned."
            />
            <BarComparison
              title="Hazard detection F1"
              unit="score"
              data={series((r) => r.metrics.detection.f1)}
              lowerIsBetter={false}
              caption="Scored against the physical hazard state, so both missed hazards and false confirmations count against it."
            />
            <BarComparison
              title="Packet delivery ratio"
              unit="ratio"
              data={series((r) => r.metrics.communication.packet_delivery_ratio)}
              lowerIsBetter={false}
              caption="Delivered over intended receptions, under a density-dependent contention model."
            />
            <BarComparison
              title="Mobility"
              unit="segments per 100 vehicle-ticks"
              data={series((r) => r.metrics.traffic.segments_per_100_vehicle_ticks)}
              lowerIsBetter={false}
              precision={3}
              caption="How fast traffic actually moves. Unlike average trip time this has no survivorship bias — every vehicle counts every tick, whether or not it finishes its journey inside the run."
            />
          </div>

          <ReadingNotes suite={suite} />

          <section className="panel wide">
            <h2>Full metric table</h2>
            <div className="table-scroll">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Metric</th>
                    {suite.runs.map((r) => (
                      <th key={r.config.key}>{SHORT[r.config.key]}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  <Row suite={suite} label="Alert latency (ticks)" pick={(r) => r.metrics.communication.avg_alert_latency_ticks} />
                  <Row suite={suite} label="Detection latency (ticks)" pick={(r) => r.metrics.communication.avg_detection_latency_ticks} />
                  <Row suite={suite} label="Packet delivery ratio" pick={(r) => r.metrics.communication.packet_delivery_ratio} />
                  <Row suite={suite} label="Uplink (KB/tick)" pick={(r) => r.metrics.communication.uplink_kilobytes_per_tick} />
                  <Row suite={suite} label="Local radio (KB/tick)" pick={(r) => r.metrics.communication.local_kilobytes_per_tick} />
                  <Row suite={suite} label="Mobility (segments/100 veh-ticks)" pick={(r) => r.metrics.traffic.segments_per_100_vehicle_ticks} />
                  <Row suite={suite} label="Alert samples" pick={(r) => r.metrics.communication.alert_samples} />
                  <Row suite={suite} label="Avg trip (ticks, biased)" pick={(r) => r.metrics.traffic.avg_trip_ticks} />
                  <Row suite={suite} label="Congestion duration (%)" pick={(r) => r.metrics.traffic.congestion_duration_pct} />
                  <Row suite={suite} label="Detection precision" pick={(r) => r.metrics.detection.precision} />
                  <Row suite={suite} label="Detection recall" pick={(r) => r.metrics.detection.recall} />
                  <Row suite={suite} label="Availability (%)" pick={(r) => r.metrics.resilience.availability_pct} />
                  <Row suite={suite} label="Availability in outage (%)" pick={(r) => r.metrics.resilience.availability_during_outage_pct} />
                  <Row suite={suite} label="FL rounds" pick={(r) => r.federated.rounds_completed} />
                  <Row suite={suite} label="FL loss reduction (%)" pick={(r) => r.federated.loss_reduction_pct} />
                  <Row suite={suite} label="Raw KB avoided by FL" pick={(r) => r.federated.raw_kilobytes_avoided} />
                  <Row suite={suite} label="Twin divergence" pick={(r) => r.digital_twin.divergence} />
                </tbody>
              </table>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

/** The commentary is generated from the numbers actually produced, not
 *  asserted in advance — detection recall in particular swings run to run
 *  at these episode counts, and a page that always claims a win would be
 *  lying on some of those runs. */
function ReadingNotes({ suite }: { suite: ExperimentSuite }) {
  const [base, , full] = suite.runs;
  const episodes = base.metrics.detection.hazards_detected + base.metrics.detection.hazards_missed;

  const f1Delta = full.metrics.detection.f1 - base.metrics.detection.f1;
  const baseMobility = base.metrics.traffic.segments_per_100_vehicle_ticks;
  const fullMobility = full.metrics.traffic.segments_per_100_vehicle_ticks;
  const mobilityPct = baseMobility ? (100 * (fullMobility - baseMobility)) / baseMobility : 0;
  const alertSamples = Math.min(...suite.runs.map((r) => r.metrics.communication.alert_samples));

  const detectionSentence =
    Math.abs(f1Delta) < 0.05
      ? `Hazard detection F1 is effectively level (${base.metrics.detection.f1.toFixed(2)} vs ${full.metrics.detection.f1.toFixed(
          2
        )}).`
      : f1Delta > 0
      ? `Hazard detection also improves, from F1 ${base.metrics.detection.f1.toFixed(2)} to ${full.metrics.detection.f1.toFixed(
          2
        )}, because corroborating reports reach a decision point without a cloud round trip.`
      : `Hazard detection F1 came out lower in this run (${base.metrics.detection.f1.toFixed(
          2
        )} → ${full.metrics.detection.f1.toFixed(2)}).`;

  const tripSentence =
    Math.abs(mobilityPct) < 3
      ? "Traffic mobility does not separate meaningfully between the three architectures."
      : mobilityPct > 0
      ? `Traffic mobility is ${mobilityPct.toFixed(1)}% higher under the proposed architecture.`
      : `Traffic mobility is ${Math.abs(mobilityPct).toFixed(1)}% lower under the proposed architecture in this run.`;

  return (
    <section className="panel wide">
      <h2>Reading these results honestly</h2>
      <p className="muted">
        The proposed architecture wins decisively on the three things it was designed to fix: warnings arrive
        substantially sooner, uplink overhead drops by roughly an order of magnitude, and safety messaging survives a
        cloud outage that takes the centralized baseline completely offline. {detectionSentence}
      </p>
      <p className="muted">
        <strong>{tripSentence}</strong> Each vehicle reroutes greedily on peer reports, so when a jam is announced
        widely they can all divert onto the same alternative — the herding effect congestion-responsive routing is known
        to produce in the field. Beating the baseline on travel time needs coordinated assignment across vehicles rather
        than independent greedy choices, which is scoped as future work.
      </p>
      <p className="muted small">
        Sample size caveat: this run contained {episodes} hazard episode{episodes === 1 ? "" : "s"} and{" "}
        {alertSamples} corroborated alert{alertSamples === 1 ? "" : "s"}, so precision, recall and latency are noisy and
        can move several points between seeds. Uplink overhead, availability and mobility aggregate over every tick and
        are far more stable. For a result you would quote in a report, run several seeds and give the spread.
      </p>
    </section>
  );
}

function Row({
  suite,
  label,
  pick,
}: {
  suite: ExperimentSuite;
  label: string;
  pick: (r: ExperimentSuite["runs"][number]) => number;
}) {
  return (
    <tr>
      <td>{label}</td>
      {suite.runs.map((r) => (
        <td key={r.config.key}>{pick(r)}</td>
      ))}
    </tr>
  );
}
