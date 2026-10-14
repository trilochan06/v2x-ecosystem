import { useState } from "react";
import { commands } from "../sim/runtime";
import type { Intervention, WhatIfResult } from "../sim/whatif";
import type { SimulationState } from "../types";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const signed = (v: number) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)} pts`;

/**
 * Ask the twin before asking the city.
 *
 * The flow is deliberately two-step and the steps are not the same colour:
 * previewing runs a forecast on the replica and changes nothing, applying
 * commits it to the live road network. A single button that did both would
 * make the twin a control panel, which is the opposite of what it is for.
 */
export function TwinWhatIf({ state }: { state: SimulationState }) {
  const [result, setResult] = useState<WhatIfResult | null>(null);
  const [applied, setApplied] = useState(false);

  // The busiest road is the interesting one to close, and saves the viewer
  // hunting for a segment id on a map.
  const busiest = [...state.segments].sort((a, b) => b.occupancy - a.occupancy)[0];

  const options: { label: string; intervention: Intervention }[] = busiest
    ? [
        { label: "Close the busiest road", intervention: { kind: "close_road", segmentId: busiest.id } },
        { label: "Stage an accident there", intervention: { kind: "accident", segmentId: busiest.id } },
        { label: "Heavy rain", intervention: { kind: "rain" } },
        { label: "Fog", intervention: { kind: "fog" } },
      ]
    : [];

  const preview = (intervention: Intervention) => {
    setResult(commands.whatIf(intervention));
    setApplied(false);
  };

  const apply = () => {
    if (!result) return;
    commands.applyIntervention(result.intervention);
    setApplied(true);
  };

  return (
    <div className="panel whatif">
      <h2>What if?</h2>
      <p className="muted small">
        Runs the change against the twin&rsquo;s replica using the same congestion model that serves
        every forecast on this site, and compares it with the replica left alone. Nothing moves on
        the road until you apply it. Read the peak alongside the mean: closing a road spreads its
        traffic over the roads that meet it, which can lower the average while making one junction
        worse.
      </p>

      <div className="whatif__options">
        {options.map((o) => (
          <button key={o.label} type="button" onClick={() => preview(o.intervention)}>
            {o.label}
          </button>
        ))}
      </div>

      {result && (
        <div className="whatif__result">
          <h3>{result.label}</h3>
          <p className="muted small">Forecast {result.horizonTicks} ticks ahead.</p>

          <dl className="whatif__figures">
            <div>
              <dt>Mean occupancy, left alone</dt>
              <dd>{pct(result.baselineMeanOccupancy)}</dd>
            </div>
            <div>
              <dt>With the change</dt>
              <dd>{pct(result.predictedMeanOccupancy)}</dd>
            </div>
            <div>
              <dt>Difference</dt>
              <dd className={result.deltaMeanOccupancy > 0 ? "is-worse" : "is-better"}>
                {signed(result.deltaMeanOccupancy)}
              </dd>
            </div>
            <div>
              <dt>Worst single road</dt>
              <dd className={result.predictedWorst > result.baselineWorst ? "is-worse" : "is-better"}>
                {pct(result.baselineWorst)} &rarr; {pct(result.predictedWorst)}
              </dd>
            </div>
            <div>
              <dt>Congested roads</dt>
              <dd>
                {result.baselineCongested} &rarr; {result.predictedCongested}
              </dd>
            </div>
          </dl>

          {result.roads.length > 0 && (
            <>
              <h4 className="whatif__subhead">Roads that move most</h4>
              <ul className="whatif__roads">
                {result.roads.map((r) => (
                  <li key={r.segmentId}>
                    <span className="whatif__road">{r.road}</span>
                    <span className="muted">
                      {pct(r.before)} &rarr; {pct(r.after)}
                    </span>
                    <span className={r.delta > 0 ? "is-worse" : "is-better"}>{signed(r.delta)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <p className="whatif__confidence small">
            Replica divergence {result.confidence.divergenceAtForecast.toFixed(3)}, last synced{" "}
            {result.confidence.stalenessTicks} ticks ago. {result.confidence.note}
          </p>

          {applied ? (
            <p className="whatif__applied small">Applied. Watch the map and the event log.</p>
          ) : (
            <button type="button" className="whatif__apply" onClick={apply}>
              Apply to the live city
            </button>
          )}
        </div>
      )}
    </div>
  );
}
