/**
 * A written record of one run, for the review folder.
 *
 * The site already exports experiment sweeps as CSV, which is the right shape
 * for comparing architectures across seeds. This is the other thing a review
 * needs: what happened in the run on screen — what was on the road, what the
 * network believed, what it caught and what it missed — in a form that can be
 * pasted into a document without reformatting.
 *
 * Markdown rather than CSV because it is mostly prose and single figures, and
 * a table of one row per metric is harder to read than a sentence. Every
 * number is taken from the live state; nothing is recomputed here, so the
 * report cannot disagree with the screen it was taken from.
 */
import type { SimulationState } from "../types";
import type { PovState } from "./pov";
import { VEHICLE_PROFILES } from "./agents";
import type { VehicleKind } from "./agents";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Vehicles by kind, so the mix is stated rather than implied. */
function fleetBreakdown(state: SimulationState): string[] {
  const counts = new Map<string, number>();
  for (const v of state.vehicles) counts.set(v.kind, (counts.get(v.kind) ?? 0) + 1);
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const total = state.vehicles.length || 1;
  return rows.map(([kind, n]) => {
    const profile = VEHICLE_PROFILES[kind as VehicleKind];
    const label = profile?.label ?? kind;
    const tags = [
      profile?.vru ? "unprotected" : "",
      profile && !profile.equipped ? "no on-board unit" : "",
    ].filter(Boolean);
    return `| ${label} | ${n} | ${((n / total) * 100).toFixed(0)}% | ${
      profile ? profile.pcu : "—"
    } | ${tags.join(", ") || "—"} |`;
  });
}

export function buildReport(state: SimulationState, pov: PovState | null): string {
  const fed = state.federated;
  const twin = state.digital_twin;
  const occupancies = state.segments.map((s) => s.occupancy);
  const meanOccupancy = occupancies.length
    ? occupancies.reduce((a, b) => a + b, 0) / occupancies.length
    : 0;
  const worst = [...state.segments].sort((a, b) => b.occupancy - a.occupancy)[0];
  const confirmed = state.segments.filter((s) => s.confirmed_incident).length;
  const real = state.segments.filter((s) => s.hazard_active).length;
  const quarantined = Object.values(state.trust ?? {}).filter((t) => t.quarantined).length;
  const savingRatio =
    fed.total_weights_kilobytes > 0
      ? fed.total_raw_kilobytes_avoided / fed.total_weights_kilobytes
      : 0;

  const lines: string[] = [
    "# V2X simulation report",
    "",
    `Generated at tick ${state.tick} of a running simulation.`,
    `Architecture: **${state.config.label}**. Cloud uplink ${state.cloud_online ? "online" : "**offline**"}.`,
    "",
    "## Traffic",
    "",
    `${state.vehicles.length} road users across ${state.segments.length} roads.`,
    "",
    "| Kind | Count | Share | Car-equivalents each | Notes |",
    "| --- | ---: | ---: | ---: | --- |",
    ...fleetBreakdown(state),
    "",
    `Mean occupancy ${pct(meanOccupancy)} of jam density.` +
      (worst ? ` Busiest road ${worst.id} at ${pct(worst.occupancy)}.` : ""),
    `${state.total_reroutes} diversions have been taken since the run began.`,
    "",
    "## What the network believed",
    "",
    `Hazards physically present: **${real}**. Hazards the network corroborated: **${confirmed}**.`,
    "",
    confirmed === real
      ? "Belief and reality agree at this instant."
      : confirmed < real
        ? `The network is currently blind to ${real - confirmed} real hazard(s) — nobody has corroborated them yet.`
        : `The network currently believes ${confirmed - real} hazard(s) that are not physically there.`,
    "",
    `Messages this tick: ${state.messages_this_tick} (${state.kilobytes_this_tick.toFixed(2)} KB). Frames rejected: ${state.frames_rejected}.`,
    `Stations quarantined by the trust registry: ${quarantined}.`,
    "",
    "## Digital twin",
    "",
    `Syncs: ${twin.syncs}. Staleness at capture: ${twin.staleness_ticks} ticks. Mean divergence from the physical road: **${twin.divergence}**.`,
    `Roads tracked: ${twin.tracked_segments}; congested in the replica: ${twin.congested_segments}.`,
    "",
    "## Federated learning",
    "",
    `Rounds completed: **${fed.rounds_completed}**.`,
    `Federated model loss: **${fed.current_loss.toFixed(6)}**.`,
    `Centralized counterfactual (same model, all raw data pooled): **${fed.centralized_loss.toFixed(6)}**.`,
    `Accuracy given up for privacy: **${fed.privacy_cost_pct.toFixed(2)}%**.`,
    "",
    `${fed.total_raw_kilobytes_avoided.toFixed(1)} KB of vehicle observations stayed on the roadside units that collected them. ${fed.total_weights_kilobytes.toFixed(
      2,
    )} KB of model parameters crossed the network` +
      (savingRatio > 0 ? `, a factor of ${savingRatio.toFixed(0)} less.` : "."),
    "",
    `Trust-weighted aggregation against plain FedAvg: ${fed.trust_weighting_gain_pct.toFixed(2)}% ${
      fed.trust_weighting_gain_pct >= 0 ? "ahead" : "behind"
    }. Rounds with a client excluded below the trust floor: ${fed.rounds_with_exclusions}.`,
    "",
  ];

  if (pov) {
    lines.push(
      "## Selected vehicle",
      "",
      `${pov.label} \`${pov.vehicleId}\` on ${pov.road}, ${pov.speedKmh} km/h in a ${pov.speedLimitKmh} zone.`,
      pov.equipped
        ? `Alerts active: ${pov.alerts.length}.`
        : "This road user carries no on-board unit, so it receives nothing and holds no alerts.",
      "",
    );
    if (pov.alerts.length) {
      lines.push("| Priority | Alert | Detail |", "| --- | --- | --- |");
      for (const a of pov.alerts)
        lines.push(`| ${a.priority} | ${a.title} | ${a.detail.replace(/\|/g, "\\|")} |`);
      lines.push("");
    }
  }

  const events = state.events ?? [];
  if (events.length) {
    lines.push("## Recent events", "");
    for (const e of events.slice(-25))
      lines.push(`- **tick ${e.tick}** · ${e.type} — ${e.message}`);
    lines.push("");
  }

  lines.push(
    "---",
    "",
    "Figures are read from the running simulation at the moment of capture, not recomputed, so they match the screen this was taken from.",
  );

  return lines.join("\n");
}

/** Filename that sorts usefully and says what it is. */
export function reportFilename(state: SimulationState): string {
  return `v2x-report-tick-${String(state.tick).padStart(5, "0")}.md`;
}
