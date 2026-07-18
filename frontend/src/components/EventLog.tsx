import type { SimulationState } from "../types";

const TYPE_ICON: Record<string, string> = {
  system_start: "\u{1F7E2}",
  ambulance_spawned: "\u{1F691}",
  malicious_spawned: "\u{26A0}",
  rsu_fault: "\u{1F534}",
  rsu_recovered: "\u{1F7E2}",
  self_heal: "\u{1F501}",
  congestion_alert: "\u{1F6A6}",
  fog_alert: "\u{1F32B}\u{FE0F}",
  fog_recovered: "\u{2601}\u{FE0F}",
  v2v_reroute: "\u{1F504}",
};

export function EventLog({ state }: { state: SimulationState }) {
  return (
    <div className="panel">
      <h2>Event Feed</h2>
      <div className="event-log">
        {state.events.map((e, i) => (
          <div key={i} className="event-row">
            <span className="event-icon">{TYPE_ICON[e.type] ?? "•"}</span>
            <span className="event-tick">t{e.tick}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
