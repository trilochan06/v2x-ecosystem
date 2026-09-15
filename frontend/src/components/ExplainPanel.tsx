import { useState } from "react";

import { junctionName, roadName } from "../sim/core";
import type { Decision, IncidentDossier, SimulationState, VehicleState } from "../types";

/**
 * The panel that answers "why".
 *
 * It has three modes because this system has three different kinds of "why",
 * and collapsing them into one would misrepresent all three:
 *
 *   a road      — what the network believes, what is actually there, who said
 *                 so, and whether those two things agree;
 *   a vehicle   — what it knows, where it is going and why it last changed
 *                 its mind, using only what was delivered to it;
 *   neither     — the running feed of decisions across the whole city.
 *
 * Every figure here is read out of the simulation. Nothing is narrated after
 * the fact from an outcome, which is the difference between an explanation and
 * a caption.
 */

interface Props {
  state: SimulationState;
  selectedSegment: string | null;
  selectedVehicle?: string | null;
}

const RISK_COLOR: Record<string, string> = {
  low: "#22c55e",
  moderate: "#eab308",
  high: "#ef4444",
};

const VERDICT_TONE: Record<string, string> = {
  "confirmed-real": "verdict-true",
  "confirmed-false": "verdict-false",
  unreported: "verdict-missed",
  clear: "verdict-clear",
};

const VERDICT_LABEL: Record<string, string> = {
  "confirmed-real": "True positive",
  "confirmed-false": "False positive",
  unreported: "Not yet confirmed",
  clear: "Clear",
};

const KIND_ICON: Record<string, string> = {
  report: "📡",
  confirm: "✅",
  divert: "↩️",
  warn: "⚠️",
  brake: "🛑",
  perceive: "👁️",
  priority: "🚦",
  trust: "📉",
  revoke: "⛔",
  collision: "💥",
  recovery: "🛻",
  attack: "🎭",
  outage: "🔌",
};

export function ExplainPanel({ state, selectedSegment, selectedVehicle }: Props) {
  const vehicle = selectedVehicle
    ? state.vehicles.find((v) => v.id === selectedVehicle)
    : undefined;
  const dossier = selectedSegment
    ? (state.dossiers ?? []).find((d) => d.segment_id === selectedSegment)
    : undefined;

  return (
    <div className="panel explain">
      <h2>Why this is happening</h2>

      {vehicle ? (
        <VehicleExplanation vehicle={vehicle} state={state} />
      ) : selectedSegment ? (
        <RoadExplanation state={state} segmentId={selectedSegment} dossier={dossier} />
      ) : (
        <DecisionFeed decisions={state.decisions ?? []} />
      )}
    </div>
  );
}

// -------------------------------------------------------------- a road
function RoadExplanation({
  state,
  segmentId,
  dossier,
}: {
  state: SimulationState;
  segmentId: string;
  dossier?: IncidentDossier;
}) {
  const segment = state.segments.find((s) => s.id === segmentId);
  const prediction = state.rsus
    .flatMap((r) => Object.values(r.predictions))
    .find((p) => p.segment_id === segmentId);
  const about = (state.decisions ?? []).filter((d) => d.where === segmentId);

  if (!segment) return <p className="muted small">That road is no longer in the city.</p>;

  return (
    <div className="explain-body">
      <div className="explain-head">
        <strong>{roadName(segmentId)}</strong>
        <span className="muted small">
          {dossier?.district ?? ""} · {Math.round(segment.occupancy * 100)}% full
        </span>
      </div>

      {/* The heart of it: belief against truth. */}
      {dossier ? (
        <>
          <div className={`verdict ${VERDICT_TONE[dossier.verdict]}`}>
            <span className="verdict-label">{VERDICT_LABEL[dossier.verdict]}</span>
            <p>{dossier.verdict_text}</p>
          </div>

          <div className="truth-table">
            <div>
              <span className="muted small">What is actually there</span>
              <strong>
                {dossier.ground_truth
                  ? (dossier.ground_truth_type || "hazard").replace(/_/g, " ")
                  : "nothing"}
              </strong>
            </div>
            <div>
              <span className="muted small">What the network believes</span>
              <strong>{dossier.believed ? "an incident" : "nothing"}</strong>
            </div>
          </div>

          {dossier.cause_code !== null && (
            <div className="explain-row">
              <span className="muted">DENM cause</span>
              <span>
                causeCode {dossier.cause_code} / subCauseCode {dossier.sub_cause_code}{" "}
                <span className="muted small">(TS 102 894-2)</span>
              </span>
            </div>
          )}
          {dossier.latency_ticks !== null && (
            <div className="explain-row">
              <span className="muted">Hazard to belief</span>
              <span>{dossier.latency_ticks} ticks</span>
            </div>
          )}

          <div className="witnesses">
            <span className="muted small">
              {dossier.distinct_witnesses} independent{" "}
              {dossier.distinct_witnesses === 1 ? "station" : "stations"} reported this road
            </span>
            {dossier.witnesses.slice(-5).map((w, i) => (
              <div key={`${w.pseudonym}-${w.tick}-${i}`} className="witness">
                <code>{w.pseudonym}</code>
                <span className="muted small">tick {w.tick}</span>
                <span className={w.trust < 0.5 ? "trust-bad" : "trust-ok"}>
                  trust {w.trust.toFixed(2)}
                </span>
              </div>
            ))}
            {!dossier.witnesses.length && (
              <p className="muted small">
                Nobody has reported it. A hazard nobody drives past is a hazard the network cannot
                know about — which is exactly why recall is below one.
              </p>
            )}
          </div>
        </>
      ) : (
        <p className="muted small">
          Nothing is wrong with this road and nobody has claimed otherwise. The forecast below is
          the edge model looking ahead anyway.
        </p>
      )}

      {/* The model half of the explanation. */}
      {prediction ? (
        <div className="forecast">
          <h3>Congestion forecast</h3>
          <div className="explain-row">
            <span className="muted">Now → +{prediction.horizon_ticks} ticks</span>
            <span>
              {(prediction.current_occupancy * 100).toFixed(0)}% →{" "}
              {(prediction.predicted_occupancy * 100).toFixed(0)}%
            </span>
          </div>
          <div className="explain-row">
            <span className="muted">Risk</span>
            <span style={{ color: RISK_COLOR[prediction.risk_level] }}>
              {prediction.risk_level.toUpperCase()}
            </span>
          </div>
          {prediction.explanation && <p className="explanation-text">{prediction.explanation}</p>}
          {prediction.top_factor && (
            <p className="muted small">
              Dominant feature: <code>{prediction.top_factor}</code> (attribution{" "}
              {prediction.top_factor_contribution.toFixed(3)})
            </p>
          )}
        </div>
      ) : (
        <p className="muted small">No RSU covers this road, so nothing is forecasting it.</p>
      )}

      {about.length > 0 && (
        <>
          <h3>What has been decided about this road</h3>
          {about.slice(0, 4).map((d) => (
            <DecisionCard key={d.id} decision={d} />
          ))}
        </>
      )}
    </div>
  );
}

// ----------------------------------------------------------- a vehicle
function VehicleExplanation({ vehicle, state }: { vehicle: VehicleState; state: SimulationState }) {
  const about = (state.decisions ?? []).filter((d) => d.subject === vehicle.id);
  const trust = state.trust[vehicle.id];

  return (
    <div className="explain-body">
      <div className="explain-head">
        <strong>{vehicle.id}</strong>
        <span className="muted small">
          on the air as <code>{vehicle.pseudonym}</code>
        </span>
      </div>

      {vehicle.crashed ? (
        <p className="explanation-text">
          Wrecked. It is not going anywhere — it blocks its lane and broadcasts the accident until a
          recovery truck lifts it out, and then it leaves the network for good.
        </p>
      ) : vehicle.parked ? (
        <p className="explanation-text">
          Parked at the end of a trip. The ignition is off, so it is transmitting nothing at all.
        </p>
      ) : (
        <p className="explanation-text">
          {vehicle.trip_purpose
            ? `${vehicle.trip_purpose[0].toUpperCase()}${vehicle.trip_purpose.slice(1)}`
            : "On a trip"}{" "}
          — heading for {junctionName(vehicle.destination)}
          {vehicle.next_node ? `, currently on ${roadName(`${vehicle.node}_${vehicle.next_node}`)}` : ""}.
        </p>
      )}

      <div className="explain-row">
        <span className="muted">Diversions this journey</span>
        <span>{vehicle.reroute_count}</span>
      </div>
      {trust && (
        <div className="explain-row">
          <span className="muted">Trust</span>
          <span className={trust.trust_score < 0.5 ? "trust-bad" : "trust-ok"}>
            {trust.trust_score.toFixed(2)} — {trust.reports_corroborated} of {trust.reports_seen}{" "}
            report{trust.reports_seen === 1 ? "" : "s"} corroborated
            {trust.quarantined ? " · quarantined" : ""}
          </span>
        </div>
      )}
      {vehicle.glosa_advice != null && (
        <div className="explain-row">
          <span className="muted">Holding for a red</span>
          <span>{Math.round(vehicle.glosa_advice)} km/h</span>
        </div>
      )}

      {vehicle.last_diversion && (
        <p className="muted small">
          It last changed route at tick {vehicle.last_diversion.tick}, to avoid{" "}
          {vehicle.last_diversion.avoided.map(roadName).join(" and ")} — on the strength of{" "}
          {vehicle.last_diversion.reason}, not anything it saw itself.
        </p>
      )}

      {about.length > 0 ? (
        about.slice(0, 5).map((d) => <DecisionCard key={d.id} decision={d} />)
      ) : (
        <p className="muted small">
          It has not had to make a decision worth recording yet — it is driving, listening and
          broadcasting where it is.
        </p>
      )}
    </div>
  );
}

// -------------------------------------------------------------- feed
function DecisionFeed({ decisions }: { decisions: Decision[] }) {
  if (!decisions.length)
    return (
      <p className="muted small">
        Nothing has needed deciding yet. Cause a crash, add an attacker or cut the cloud, and every
        decision the network makes in response will be written down here with the evidence behind
        it. Click any road or vehicle to interrogate it directly.
      </p>
    );

  return (
    <div className="explain-body">
      <p className="muted small">
        Every consequential decision, newest first, with the evidence it had and the rule it
        applied. Click a road or a vehicle on the map to narrow this down.
      </p>
      {decisions.slice(0, 8).map((d) => (
        <DecisionCard key={d.id} decision={d} />
      ))}
    </div>
  );
}

function DecisionCard({ decision }: { decision: Decision }) {
  const [open, setOpen] = useState(false);

  return (
    <div className={`decision decision-${decision.kind}`}>
      <button className="decision-head" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="decision-icon" aria-hidden="true">
          {KIND_ICON[decision.kind] ?? "•"}
        </span>
        <span className="decision-headline">{decision.headline}</span>
        <span className="decision-tick">t{decision.tick}</span>
      </button>

      {open && (
        <div className="decision-body">
          <span className="decision-label">What it had to go on</span>
          <ul>
            {decision.evidence.map((e) => (
              <li key={e}>{e}</li>
            ))}
          </ul>
          <span className="decision-label">The rule it applied</span>
          <p>{decision.rule}</p>
          <span className="decision-label">What changed</span>
          <p>{decision.effect}</p>
        </div>
      )}
    </div>
  );
}
