import { junctionName, roadName } from "../../sim/core";
import type { IncidentDossier, SimulationState } from "../../types";

/**
 * The popup that appears where something went wrong.
 *
 * Until now, something going wrong turned a road a different colour and added
 * a line to a log in the corner. Both are true and neither is noticeable: a
 * viewer watching the map misses the event, and a viewer watching the log is
 * not watching the map. The information had to come to the place the eye
 * already is, which is the thing that just changed.
 *
 * It says what happened in one sentence, where in street names, and — the part
 * that makes it worth having rather than merely decorative — whether the
 * network is right about it. A confirmed incident with nothing behind it is a
 * fabrication, and this is where that becomes visible without anyone having to
 * go looking.
 */

export interface MapAlertContent {
  /** What the alert is about — a segment id or a node. */
  where: string;
  kind: "collision" | "hazard" | "attack" | "outage" | "rsu" | "pedestrian";
  title: string;
  body: string;
  tick: number;
}

const KIND_STYLE: Record<MapAlertContent["kind"], { icon: string; tone: string }> = {
  collision: { icon: "💥", tone: "alert-bad" },
  hazard: { icon: "⚠️", tone: "alert-warn" },
  attack: { icon: "🎭", tone: "alert-suspect" },
  outage: { icon: "🔌", tone: "alert-warn" },
  rsu: { icon: "📡", tone: "alert-warn" },
  pedestrian: { icon: "🚶", tone: "alert-warn" },
};

const VERDICT_LINE: Record<string, string> = {
  "confirmed-real": "The network has confirmed it, and it is really there.",
  "confirmed-false": "The network has confirmed it — and there is nothing there. A fabrication.",
  unreported: "Nobody has corroborated it yet, so the network does not believe it.",
  clear: "",
};

interface Props {
  alert: MapAlertContent;
  /** 0..1 position inside the drawn map. */
  left: number;
  top: number;
  state: SimulationState;
  onDismiss: () => void;
  onExplain: () => void;
}

export function MapAlert({ alert, left, top, state, onDismiss, onExplain }: Props) {
  const style = KIND_STYLE[alert.kind];
  // Only the road this alert is actually about. An alert anchored to a
  // junction — an attacker joining, a unit going down — has no dossier, and
  // borrowing a nearby road's would be worse than showing none.
  const dossier: IncidentDossier | undefined = alert.where.includes("_")
    ? (state.dossiers ?? []).find((d) => d.segment_id === alert.where)
    : undefined;
  const verdict = dossier ? VERDICT_LINE[dossier.verdict] : "";
  // Flip to the other side when it would otherwise hang off the edge.
  const flipX = left > 0.62;
  const flipY = top < 0.28;

  return (
    <div
      className={`map-alert ${style.tone} ${flipX ? "flip-x" : ""} ${flipY ? "flip-y" : ""}`}
      style={{ left: `${left * 100}%`, top: `${top * 100}%` }}
      role="status"
    >
      <div className="map-alert-head">
        <span className="map-alert-icon" aria-hidden="true">
          {style.icon}
        </span>
        <strong>{alert.title}</strong>
        <button className="map-alert-close" onClick={onDismiss} aria-label="Dismiss">
          ×
        </button>
      </div>
      <p className="map-alert-where">
        {alert.where.includes("_") ? roadName(alert.where) : junctionName(alert.where)} · tick{" "}
        {alert.tick}
      </p>
      <p className="map-alert-body">{alert.body}</p>
      {verdict && <p className="map-alert-verdict">{verdict}</p>}
      {dossier && (
        <p className="map-alert-meta">
          {dossier.distinct_witnesses} independent{" "}
          {dossier.distinct_witnesses === 1 ? "station has" : "stations have"} reported it
          {dossier.latency_ticks !== null ? ` · believed after ${dossier.latency_ticks} ticks` : ""}
        </p>
      )}
      <button className="map-alert-explain" onClick={onExplain}>
        Why did this happen? →
      </button>
      <span className="map-alert-tail" aria-hidden="true" />
    </div>
  );
}
