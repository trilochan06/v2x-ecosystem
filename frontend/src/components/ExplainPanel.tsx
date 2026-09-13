import type { SimulationState } from "../types";

interface Props {
  state: SimulationState;
  selectedSegment: string | null;
}

const RISK_COLOR: Record<string, string> = {
  low: "#22c55e",
  moderate: "#eab308",
  high: "#ef4444",
};

export function ExplainPanel({ state, selectedSegment }: Props) {
  const prediction = selectedSegment
    ? state.rsus.flatMap((r) => Object.values(r.predictions)).find((p) => p.segment_id === selectedSegment)
    : undefined;

  const segment = selectedSegment ? state.segments.find((s) => s.id === selectedSegment) : undefined;

  return (
    <div className="panel">
      <h2>Explainable AI</h2>
      {!selectedSegment && <p className="muted">Click a road segment on the map to inspect its forecast.</p>}
      {selectedSegment && !prediction && (
        <p className="muted">No RSU currently covers this segment (out of edge-AI range).</p>
      )}
      {prediction && segment && (
        <div className="explain-body">
          <div className="explain-row">
            <span className="muted">Segment</span>
            <span>{segment.id}</span>
          </div>
          <div className="explain-row">
            <span className="muted">Current occupancy</span>
            <span>{(prediction.current_occupancy * 100).toFixed(0)}%</span>
          </div>
          <div className="explain-row">
            <span className="muted">Predicted (+{prediction.horizon_ticks} ticks)</span>
            <span>{(prediction.predicted_occupancy * 100).toFixed(0)}%</span>
          </div>
          <div className="explain-row">
            <span className="muted">Risk</span>
            <span style={{ color: RISK_COLOR[prediction.risk_level] }}>{prediction.risk_level.toUpperCase()}</span>
          </div>
          <div className="explain-row">
            <span className="muted">Hazard state</span>
            <span>
              {segment.hazard_active ? `${segment.hazard_type || "hazard"} present` : "clear"}
              {segment.confirmed_incident && " · network-confirmed"}
            </span>
          </div>
          {prediction.model && (
            <div className="explain-row">
              <span className="muted">Model</span>
              <span>
                {prediction.model}
                {prediction.centralized_reference !== undefined &&
                  ` (centralized ref ${(prediction.centralized_reference * 100).toFixed(0)}%)`}
              </span>
            </div>
          )}
          {prediction.explanation && <p className="explanation-text">{prediction.explanation}</p>}
          {prediction.top_factor && (
            <p className="muted small">
              Dominant feature: <code>{prediction.top_factor}</code> (attribution{" "}
              {prediction.top_factor_contribution.toFixed(3)})
            </p>
          )}
        </div>
      )}
    </div>
  );
}
