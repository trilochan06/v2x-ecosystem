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
  hazard: "\u{26A0}\u{FE0F}",
  incident_confirmed: "\u{2705}",
  cloud_outage: "\u{1F4F5}",
  cloud_restored: "\u{1F4F6}",
  fl_round: "\u{1F9E0}",
  pseudonym_rotation: "\u{1F510}",
  certificate_revoked: "\u{1F6AB}",
  attack_blocked: "\u{1F6E1}\u{FE0F}",
};

export function EventLog({ state }: { state: SimulationState }) {
  return (
    <div className="panel">
      <h2 id="event-feed-heading">Event Feed</h2>
      {/* A screen reader should hear new events as they arrive, but politely
          so it never interrupts what the user is already reading. */}
      <div
        className="event-log"
        role="log"
        aria-live="polite"
        aria-labelledby="event-feed-heading"
      >
        {state.events.map((e, i) => (
          <div key={i} className="event-row">
            {/* The icon duplicates the message text, so it is decoration. */}
            <span className="event-icon" aria-hidden="true">
              {TYPE_ICON[e.type] ?? "•"}
            </span>
            <span className="event-tick">t{e.tick}</span>
            <span>{e.message}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
