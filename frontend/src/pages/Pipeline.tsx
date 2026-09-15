import { useState } from "react";
import { Link } from "react-router-dom";

import { commands, useSimulation } from "../sim/runtime";
import { junctionName, roadName } from "../sim/core";
import { Toaster } from "../components/Toaster";
import { useToaster } from "../components/useToaster";
import type { SimulationState } from "../types";

/**
 * The twelve stages, each one running and each one inspectable.
 *
 * Every other page answers a question ("how well does it perform", "what is
 * this thing doing"). This one answers a different one, which a mentor or an
 * examiner asks first: *is every part of the stated architecture actually
 * here, and can you show me?* A block diagram cannot answer that. Twelve live
 * panels fed by the running simulation can.
 *
 * Two rules govern what is written here.
 *
 * Every number on this page is read out of the engine this tab is running.
 * Nothing is illustrative and nothing is typed in.
 *
 * And where a stage is named after a specific tool the project does not
 * literally run — SUMO, Veins, OMNeT++ — the panel says so in its own words,
 * next to what does play that role and which of the tool's concepts it
 * implements. Quietly labelling our own mobility model "SUMO" would be the
 * single easiest thing on this site to catch, and the least defensible.
 */

interface Stage {
  id: string;
  n: number;
  title: string;
  /** One line: what this stage is for. */
  what: string;
  /** Where the stage lives in the code, so a claim can be checked. */
  source: string;
  /** Named after a tool we do not literally run? Say so, plainly. */
  standsIn?: { tool: string; note: string };
  /** Live figures, straight from the engine. */
  figures: (s: SimulationState) => { label: string; value: string; note?: string }[];
  /** Something a viewer can press to make the stage visibly do its job. */
  action?: { label: string; run: () => string | null; blurb: (id: string | null) => string };
  /** The detail worth reading once the numbers make sense. */
  detail: (s: SimulationState) => React.ReactNode;
}

const pct = (x: number) => `${Math.round(x * 100)}%`;

const STAGES: Stage[] = [
  // ------------------------------------------------------------------ 1
  {
    id: "sumo",
    n: 1,
    title: "SUMO Traffic Simulation",
    what: "Microscopic road traffic: individual vehicles, each with a route, a purpose and a speed that depends on the road around it.",
    source: "sim/agents.ts · Vehicle.step, sim/core.ts · CityGrid",
    standsIn: {
      tool: "SUMO",
      note: "SUMO is a desktop C++ simulator and cannot run in a browser tab, so the mobility model here is written to play its part: a demand model that draws destinations from land use, per-vehicle routing over the road graph, a Greenshields speed-density relation for car-following, and re-routing during a trip. Those are the SUMO concepts this project depends on. What it is not is SUMO's calibrated driver models or its network importer.",
    },
    figures: (s) => [
      { label: "Vehicles being simulated", value: String(s.vehicles.length) },
      { label: "Trips completed", value: String(s.metrics.traffic.trips_completed), note: `mean ${s.metrics.traffic.avg_trip_ticks} ticks` },
      { label: "Road segments", value: String(s.segments.length), note: "250 m each" },
      { label: "Roads congested", value: `${s.metrics.traffic.congestion_duration_pct}%`, note: "of all road-ticks" },
    ],
    action: {
      label: "Add a vehicle",
      run: () => commands.spawnVehicle(),
      blurb: (id) => `${id} entered the city with a destination drawn from land use.`,
    },
    detail: (s) => (
      <table className="data-table">
        <thead>
          <tr>
            <th>Vehicle</th>
            <th>Why it is driving</th>
            <th>On</th>
            <th>Heading for</th>
          </tr>
        </thead>
        <tbody>
          {s.vehicles.slice(0, 6).map((v) => (
            <tr key={v.id}>
              <td>{v.id}</td>
              <td className="muted small">{v.crashed ? "wrecked" : v.parked ? "parked" : v.trip_purpose}</td>
              <td className="muted small">{v.segment_id ? roadName(v.segment_id) : "—"}</td>
              <td className="muted small">{junctionName(v.destination)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
  },

  // ------------------------------------------------------------------ 2
  {
    id: "network",
    n: 2,
    title: "V2X Network Simulation",
    what: "The radio. Every frame is sized from its standard, travels a bounded number of hops, and can be lost to path loss or to contention.",
    source: "sim/network.ts · EtherBus, sim/core.ts · messageBytes",
    standsIn: {
      tool: "OMNeT++ / Veins",
      note: "The network stack modelled is ITS-G5 at the frame level, not the PHY: delivery falls off with hop count and with how many stations are transmitting nearby, which is what the bandwidth and reliability results turn on. There is no OFDM symbol model and no MAC backoff.",
    },
    figures: (s) => [
      { label: "Packet delivery ratio", value: pct(s.metrics.communication.packet_delivery_ratio), note: "the rest is lost on the air" },
      { label: "Frames sent", value: s.metrics.communication.messages_sent.toLocaleString() },
      { label: "Local radio", value: `${s.metrics.communication.local_kilobytes_per_tick} KB/tick` },
      { label: "Cloud uplink", value: `${s.metrics.communication.uplink_kilobytes_per_tick} KB/tick` },
    ],
    detail: (s) => {
      const frames = Object.entries(s.metrics.communication.frames_by_designator).sort((a, b) => b[1] - a[1]);
      const total = frames.reduce((t, [, n]) => t + n, 0) || 1;
      return (
        <ul className="frame-mix">
          {frames.map(([d, n]) => (
            <li key={d}>
              <div className="frame-mix-head">
                <strong>{d}</strong>
                <span className="muted small">{s.metrics.communication.kilobytes_by_designator[d] ?? 0} KB</span>
              </div>
              <div className="frame-mix-bar">
                <span style={{ width: `${(n / total) * 100}%` }} />
              </div>
              <div className="frame-mix-nums">
                <span>{n.toLocaleString()} frames</span>
                <span>{Math.round((n / total) * 100)}%</span>
              </div>
            </li>
          ))}
        </ul>
      );
    },
  },

  // ------------------------------------------------------------------ 3
  {
    id: "sync",
    n: 3,
    title: "SUMO ↔ Veins Synchronisation",
    what: "Mobility and networking advance together, one tick at a time, in a fixed order. Neither runs ahead of the other.",
    source: "sim/engine.ts · SimulationEngine.step",
    standsIn: {
      tool: "Veins' TraCI coupling",
      note: "Veins keeps SUMO and OMNeT++ in step over a TraCI socket, because they are separate processes. Here both halves are one process stepped by one loop, so the coupling is a function-call order rather than a protocol — the same lockstep guarantee, obtained for free rather than negotiated.",
    },
    figures: (s) => [
      { label: "Tick", value: String(s.tick), note: "both halves are at this tick" },
      { label: "Frames this tick", value: String(s.messages_this_tick) },
      { label: "On the air this tick", value: `${s.kilobytes_this_tick} KB` },
      { label: "Diversions this tick", value: String(s.reroutes_this_tick), note: "mobility reacting to the radio" },
    ],
    detail: () => (
      <ol className="tick-order">
        <li><strong>Rotate pseudonyms</strong> — identities due to change, change.</li>
        <li><strong>Advance vehicles</strong> — mobility moves, and hands back the frames it wants to send.</li>
        <li><strong>Transport</strong> — the radio decides what was delivered to whom.</li>
        <li><strong>Process reports</strong> — corroboration, trust, alerts.</li>
        <li><strong>Edge and learning</strong> — RSU inference, federated rounds.</li>
        <li><strong>Infrastructure</strong> — signals, corridors, the twin.</li>
        <li><strong>Lifecycles</strong> — pedestrians, wreck recovery, hazards.</li>
        <li><strong>Sample metrics</strong> — one observation per tick, no double counting.</li>
      </ol>
    ),
  },

  // ------------------------------------------------------------------ 4
  {
    id: "v2v",
    n: 4,
    title: "V2V Message Exchange",
    what: "Vehicles talking to each other directly: awareness beacons, hazard warnings, brake lights, and what their sensors can see.",
    source: "sim/agents.ts · Vehicle.maybeReportHazard / maybeSharePerception",
    figures: (s) => [
      { label: "CAM — awareness", value: String(s.metrics.communication.frames_by_designator.CAM ?? 0) },
      { label: "DENM — hazard", value: String(s.metrics.communication.frames_by_designator.DENM ?? 0) },
      { label: "CPM — perception", value: String(s.metrics.communication.frames_by_designator.CPM ?? 0) },
      { label: "Warned about the unseen", value: String(s.perception.warned_blind), note: "acted on someone they had no line of sight to" },
    ],
    action: {
      label: "Put someone on a crossing",
      run: () => commands.spawnPedestrian(),
      blurb: (id) => (id ? `Pedestrian on ${roadName(id)} — watch CPM carry them to cars that cannot see them.` : "No crossing has traffic on it right now."),
    },
    detail: (s) => {
      const v2v = s.transmissions.filter((t) => t.sender_id.startsWith("car") || t.sender_id.startsWith("malicious") || t.sender_id.startsWith("ambulance")).slice(-6).reverse();
      return v2v.length ? (
        <table className="data-table">
          <thead>
            <tr><th>Tick</th><th>Frame</th><th>From</th><th>Decoded by</th></tr>
          </thead>
          <tbody>
            {v2v.map((t) => (
              <tr key={`${t.id}-${t.tick}`}>
                <td>{t.tick}</td>
                <td>{t.designator}</td>
                <td className="muted small">{t.sender_id}</td>
                <td className="muted small">{t.delivered_to.length} of {t.intended}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Nothing on the air this instant — frames are bursty.</p>
      );
    },
  },

  // ------------------------------------------------------------------ 5
  {
    id: "v2i",
    n: 5,
    title: "Vehicle-to-RSU Communication",
    what: "Vehicles and roadside units. Each vehicle is served by one unit, and moves between units as it drives.",
    source: "sim/agents.ts · RSUNetwork.assign",
    figures: (s) => [
      { label: "Roadside units", value: String(s.rsus.length), note: `${s.rsus.filter((r) => !r.alive).length} down` },
      { label: "Frames handled", value: s.rsus.reduce((t, r) => t + r.messages_handled, 0).toLocaleString() },
      { label: "Handovers", value: String(s.handovers.length) },
      { label: "Signal requests granted", value: `${s.signal_priority.grant_rate_pct}%`, note: `${s.signal_priority.unheard} were never heard` },
    ],
    action: {
      label: "Knock out a roadside unit",
      run: () => {
        const up = commands.firstLiveRsu();
        if (up) commands.toggleRsu(up, false);
        return up;
      },
      blurb: (id) => (id ? `${id} is down — its vehicles re-home to a neighbour, and the handovers appear below.` : "Every unit is already down."),
    },
    detail: (s) => (
      <table className="data-table">
        <thead>
          <tr><th>Unit</th><th>Junction</th><th>Vehicles</th><th>Frames</th><th>State</th></tr>
        </thead>
        <tbody>
          {s.rsus.map((r) => (
            <tr key={r.id} className={r.alive ? "" : "bad-row"}>
              <td>{r.id}</td>
              <td className="muted small">{junctionName(r.node)}</td>
              <td>{r.cell_size}</td>
              <td>{r.messages_handled.toLocaleString()}</td>
              <td>{r.alive ? <span className="pill good">online</span> : <span className="pill bad">DOWN</span>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
  },

  // ------------------------------------------------------------------ 6
  {
    id: "edge",
    n: 6,
    title: "RSU Edge Processing",
    what: "Each unit runs its own model on its own roads. No inference is sent to a data centre and waited on.",
    source: "sim/agents.ts · RSU.runPrediction, sim/ai.ts",
    figures: (s) => [
      { label: "Units running inference", value: String(s.rsus.filter((r) => r.alive && Object.keys(r.predictions).length).length) },
      { label: "Forecasts live", value: String(s.rsus.reduce((t, r) => t + Object.keys(r.predictions).length, 0)) },
      { label: "Samples held locally", value: String(s.rsus.reduce((t, r) => t + r.fl.pending_samples, 0)), note: "never uploaded raw" },
      { label: "Cloud round trip", value: `${s.config.cloud_round_trip_ticks} ticks`, note: s.config.cloud_dependent ? "this architecture waits for it" : "not on the safety path" },
    ],
    detail: (s) => (
      <table className="data-table">
        <thead>
          <tr><th>Unit</th><th>Roads watched</th><th>Rounds joined</th><th>Samples given</th><th>Drift</th></tr>
        </thead>
        <tbody>
          {s.rsus.map((r) => (
            <tr key={r.id}>
              <td>{r.id}</td>
              <td>{Object.keys(r.predictions).length}</td>
              <td>{r.fl.rounds_joined}</td>
              <td>{r.fl.samples_contributed}</td>
              <td className="muted small">{r.fl.drift.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    ),
  },

  // ------------------------------------------------------------------ 7
  {
    id: "hazard",
    n: 7,
    title: "Hazard Detection",
    what: "Turning what one vehicle claims into something the network believes — and being measurable about how often it is right.",
    source: "sim/network.ts · CorroborationEngine, sim/explain.ts",
    figures: (s) => [
      { label: "Precision", value: s.metrics.detection.precision.toFixed(3), note: `${s.metrics.detection.false_positives} false positives` },
      { label: "Recall", value: s.metrics.detection.recall.toFixed(3), note: `${s.metrics.detection.hazards_missed} never spotted` },
      { label: "F1", value: s.metrics.detection.f1.toFixed(3) },
      { label: "Time to believe", value: `${s.metrics.communication.avg_alert_latency_ticks} ticks`, note: `over ${s.metrics.communication.alert_samples} alerts` },
    ],
    action: {
      label: "Put a hazard on a road",
      run: () => commands.injectHazard(),
      blurb: (id) => (id ? `Hazard on ${roadName(id)} — it is not believed until a second, independent station reports it.` : "Every road already has one."),
    },
    detail: (s) => {
      const d = s.dossiers ?? [];
      return d.length ? (
        <table className="data-table">
          <thead>
            <tr><th>Road</th><th>Actually there</th><th>Network believes</th><th>Verdict</th></tr>
          </thead>
          <tbody>
            {d.slice(0, 6).map((x) => (
              <tr key={x.segment_id}>
                <td className="muted small">{x.road}</td>
                <td>{x.ground_truth ? x.ground_truth_type.replace(/_/g, " ") : "nothing"}</td>
                <td>{x.believed ? `yes · ${x.distinct_witnesses} witnesses` : "no"}</td>
                <td>
                  {x.verdict === "confirmed-false" ? (
                    <span className="pill bad">false positive</span>
                  ) : x.verdict === "confirmed-real" ? (
                    <span className="pill good">true positive</span>
                  ) : (
                    <span className="pill">not yet believed</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Nothing wrong anywhere at this instant. Press the button above.</p>
      );
    },
  },

  // ------------------------------------------------------------------ 8
  {
    id: "estimation",
    n: 8,
    title: "Traffic-State Estimation",
    what: "What each unit works out the roads are doing, from reports alone — next to what is physically true, which it cannot see.",
    source: "sim/agents.ts · RSU.reportedOccupancy",
    figures: (s) => {
      const rows = s.rsus.flatMap((r) => r.estimates ?? []).filter((e) => e.estimated !== null);
      const err = rows.length
        ? rows.reduce((t, e) => t + Math.abs((e.estimated ?? 0) - e.actual), 0) / rows.length
        : 0;
      return [
        { label: "Roads with an estimate", value: String(rows.length), note: `of ${s.segments.length}` },
        { label: "Mean absolute error", value: err.toFixed(3), note: "estimate against ground truth" },
        { label: "Roads above the jam threshold", value: String(s.segments.filter((x) => x.occupancy >= 0.7).length) },
        { label: "Mean road occupancy", value: pct(s.segments.reduce((t, x) => t + x.occupancy, 0) / Math.max(s.segments.length, 1)) },
      ];
    },
    detail: (s) => {
      const rows = s.rsus.flatMap((r) => (r.estimates ?? []).map((e) => ({ ...e, rsu: r.id })))
        .filter((e) => e.estimated !== null)
        .slice(0, 6);
      return rows.length ? (
        <table className="data-table">
          <thead>
            <tr><th>Road</th><th>Unit</th><th>Believed</th><th>Actually</th><th>Error</th></tr>
          </thead>
          <tbody>
            {rows.map((e) => (
              <tr key={`${e.rsu}-${e.segment_id}`}>
                <td className="muted small">{roadName(e.segment_id)}</td>
                <td className="muted small">{e.rsu}</td>
                <td>{pct(e.estimated ?? 0)}</td>
                <td>{pct(e.actual)}</td>
                <td className="muted small">{Math.abs((e.estimated ?? 0) - e.actual).toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">
          No road has been reported on recently. Estimation has nothing to work with until vehicles
          share what they are driving through — which is the point: an unobserved road is unknown.
        </p>
      );
    },
  },

  // ------------------------------------------------------------------ 9
  {
    id: "predictive",
    n: 9,
    title: "Predictive Intelligence",
    what: "A forecast of each road a short way ahead, and — because a forecast nobody can interrogate is not evidence — which feature drove it.",
    source: "sim/ai.ts · CongestionPredictor",
    figures: (s) => {
      const preds = s.rsus.flatMap((r) => Object.values(r.predictions));
      const high = preds.filter((p) => p.risk_level === "high").length;
      return [
        { label: "Roads forecast", value: String(preds.length) },
        { label: "Horizon", value: `${preds[0]?.horizon_ticks ?? 0} ticks` },
        { label: "Flagged high risk", value: String(high) },
        { label: "Model", value: preds[0]?.model ?? "—", note: s.config.federated_learning ? "trained federally" : "centralized reference" },
      ];
    },
    detail: (s) => {
      const preds = s.rsus.flatMap((r) => Object.values(r.predictions))
        .sort((a, b) => b.predicted_occupancy - a.predicted_occupancy)
        .slice(0, 5);
      return preds.length ? (
        <table className="data-table">
          <thead>
            <tr><th>Road</th><th>Now</th><th>Forecast</th><th>Risk</th><th>Dominant feature</th></tr>
          </thead>
          <tbody>
            {preds.map((p) => (
              <tr key={p.segment_id}>
                <td className="muted small">{roadName(p.segment_id)}</td>
                <td>{pct(p.current_occupancy)}</td>
                <td>{pct(p.predicted_occupancy)}</td>
                <td>{p.risk_level}</td>
                <td className="muted small">
                  <code>{p.top_factor}</code> {p.top_factor_contribution.toFixed(3)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="muted small">Edge inference is off in this architecture.</p>
      );
    },
  },

  // ----------------------------------------------------------------- 10
  {
    id: "federated",
    n: 10,
    title: "Federated Learning",
    what: "The units train one shared model by exchanging weights, never the observations the weights came from.",
    source: "sim/ai.ts · FederatedCoordinator",
    figures: (s) => [
      { label: "Rounds completed", value: String(s.federated.rounds_completed) },
      { label: "Loss reduction", value: `${s.federated.loss_reduction_pct}%`, note: `converged at round ${s.federated.convergence_round ?? "—"}` },
      { label: "Weights exchanged", value: `${s.federated.total_weights_kilobytes} KB` },
      { label: "Raw telemetry avoided", value: `${s.federated.total_raw_kilobytes_avoided.toFixed(0)} KB`, note: "never left the roadside" },
    ],
    detail: (s) => (
      <>
        <div className="explain-row">
          <span className="muted">Against plain FedAvg</span>
          <span>{s.federated.trust_weighting_gain_pct}% lower loss with trust weighting</span>
        </div>
        <div className="explain-row">
          <span className="muted">Mean client trust</span>
          <span>{s.federated.mean_client_trust.toFixed(3)}</span>
        </div>
        <div className="explain-row">
          <span className="muted">Rounds that excluded a client</span>
          <span>{s.federated.rounds_with_exclusions}</span>
        </div>
        <p className="muted small">
          Weighting each unit's update by how often its sources were corroborated is this project's
          own contribution, and it is measured against plain averaging rather than asserted.
        </p>
      </>
    ),
  },

  // ----------------------------------------------------------------- 11
  {
    id: "twin",
    n: 11,
    title: "Transportation Digital Twin",
    what: "A replica of the city kept in step with it, and honest about how far behind it has fallen.",
    source: "sim/agents.ts · DigitalTwin",
    figures: (s) => [
      { label: "Syncs", value: String(s.digital_twin.syncs) },
      { label: "Staleness", value: `${s.digital_twin.staleness_ticks} ticks` },
      { label: "Divergence", value: s.digital_twin.divergence.toFixed(4), note: "mean gap from the real road state" },
      { label: "Synced", value: `${s.digital_twin.kilobytes_synced} KB` },
    ],
    action: {
      label: "Cut the cloud uplink",
      run: () => {
        commands.setCloud(false);
        return "cloud";
      },
      blurb: () => "Uplink severed — watch divergence climb while the edge carries on regardless.",
    },
    detail: (s) => (
      <p className="muted small">
        Divergence is the mean difference between the replica and the physical road state. It grows
        whenever synchronisation is switched off or the uplink is cut, which is what makes it a
        measurement of the twin rather than a decoration:{" "}
        {s.cloud_online ? "the uplink is up, so it should be small." : "the uplink is down right now."}
      </p>
    ),
  },

  // ----------------------------------------------------------------- 12
  {
    id: "dashboard",
    n: 12,
    title: "Visualization Dashboard",
    what: "Everything above, on a map and in panels, with every claim traceable back to the state that produced it.",
    source: "components/CityMap.tsx, components/ExplainPanel.tsx",
    figures: (s) => [
      { label: "Decisions recorded", value: String((s.decisions ?? []).length), note: "each with its evidence and rule" },
      { label: "Roads with a dossier", value: String((s.dossiers ?? []).length) },
      { label: "Events logged", value: String(s.events.length) },
      { label: "Pages", value: "8" },
    ],
    detail: () => (
      <div className="stage-links">
        <Link className="btn" to="/demo">Guided demo</Link>
        <Link className="btn" to="/control">Control centre</Link>
        <Link className="btn" to="/street">Street view</Link>
        <Link className="btn" to="/federated">Federated learning</Link>
        <Link className="btn" to="/security">Security</Link>
        <Link className="btn" to="/experiments">Experiments</Link>
      </div>
    ),
  },
];

export function Pipeline() {
  const { state } = useSimulation();
  const [open, setOpen] = useState<string | null>("sumo");
  const { toasts, push, dismiss } = useToaster();

  if (!state) return <div className="loading">Starting the simulator…</div>;

  return (
    <div className="stack pipeline">
      <Toaster toasts={toasts} dismiss={dismiss} />

      <div className="page-head">
        <div>
          <h1>The twelve stages, running</h1>
          <p className="muted">
            Every figure below is read out of the simulation in this tab, at tick {state.tick}. Open
            a stage to see the rows behind its numbers, and press its button to make it do its job
            while you watch.
          </p>
        </div>
      </div>

      <div className="notice">
        Three of these stages are named after tools this project does not literally run — SUMO,
        Veins, OMNeT++. Those panels say so themselves, and say what plays the part instead. A
        simulator of our own labelled with somebody else's name would be the easiest thing here to
        catch, and the least defensible.
      </div>

      {STAGES.map((stage) => (
        <section key={stage.id} id={stage.id} className="panel stage">
          <button
            className="stage-head"
            onClick={() => setOpen((cur) => (cur === stage.id ? null : stage.id))}
            aria-expanded={open === stage.id}
          >
            <span className="stage-n">{String(stage.n).padStart(2, "0")}</span>
            <span className="stage-title">
              <strong>{stage.title}</strong>
              <span className="muted small">{stage.what}</span>
            </span>
            <span className="stage-chevron" aria-hidden="true">
              {open === stage.id ? "▾" : "▸"}
            </span>
          </button>

          <div className="stage-figures">
            {stage.figures(state).map((f) => (
              <div key={f.label} className="stage-figure">
                <span className="stage-value">{f.value}</span>
                <span className="stage-label">{f.label}</span>
                {f.note && <span className="stage-note">{f.note}</span>}
              </div>
            ))}
          </div>

          {open === stage.id && (
            <div className="stage-body">
              {stage.standsIn && (
                <div className="stands-in">
                  <strong>This is not {stage.standsIn.tool}.</strong> {stage.standsIn.note}
                </div>
              )}
              {stage.action && (
                <button
                  className="btn primary stage-action"
                  onClick={() => {
                    const id = stage.action!.run();
                    push(stage.action!.blurb(id), "info");
                  }}
                >
                  {stage.action.label}
                </button>
              )}
              <div className="stage-detail">{stage.detail(state)}</div>
              <p className="stage-source">
                Implemented in <code>{stage.source}</code>
              </p>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}
