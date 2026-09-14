/**
 * The guided demo's scripted stories.
 *
 * A live simulation is honest and, to someone seeing V2X for the first time,
 * nearly unreadable: things happen everywhere at once and none of it is
 * labelled. The control centre answers "how well does this perform"; this
 * answers "what is it actually doing", which is a different question and
 * needs a different shape.
 *
 * So each scenario is a short story with numbered beats. `setup` makes the
 * event happen; each beat then watches the live state and latches the moment
 * it becomes true. Nothing here fakes an outcome — a beat that the simulation
 * does not produce simply never lights up, which is the honest way to show a
 * system that does not succeed every single time.
 */
import type { SimulationEngine } from "./engine";
import type { SimulationState } from "../types";

/** The state of the world when a scenario started, so beats can say "more
 *  than before" rather than "more than zero" — the engine has usually been
 *  running for a while before the viewer picks a story. */
export interface Baseline {
  tick: number;
  collisions: number;
  denm: number;
  cpm: number;
  spatem: number;
  brakeWarnings: number;
  shared: number;
  warnedBlind: number;
  alertsDelivered: number;
  sremRequested: number;
  sremGranted: number;
  revoked: number;
  flRounds: number;
  reroutes: number;
  rawKbAvoided: number;
}

const frames = (s: SimulationState, designator: string) =>
  s.metrics.communication.frames_by_designator[designator] ?? 0;

export function baselineOf(s: SimulationState): Baseline {
  return {
    tick: s.tick,
    collisions: s.collisions.length,
    denm: frames(s, "DENM"),
    cpm: frames(s, "CPM"),
    spatem: frames(s, "SPATEM"),
    brakeWarnings: s.perception.brake_warnings,
    shared: s.perception.shared,
    warnedBlind: s.perception.warned_blind,
    alertsDelivered: s.alerts.alerts_delivered,
    sremRequested: s.signal_priority.requested,
    sremGranted: s.signal_priority.granted,
    revoked: s.security.pseudonyms.revoked_vehicles,
    flRounds: s.federated.rounds_completed,
    reroutes: s.total_reroutes,
    rawKbAvoided: s.federated.total_raw_kilobytes_avoided,
  };
}

export interface Beat {
  /** Short label, written for someone who has never heard of V2X. */
  text: string;
  /** The standards-level detail, for the viewer who wants it. */
  detail?: string;
  /**
   * This one genuinely does not happen on every run — the radio is lossy and
   * the road layout varies. Marked so a step that stays dark reads as the
   * system being honest rather than the demo being broken, and so it does not
   * hold the story back from showing as complete.
   */
  optional?: boolean;
  /** Has this happened yet? Latched by the runtime once true. */
  done: (s: SimulationState, base: Baseline) => boolean;
}

export interface Scenario {
  id: string;
  icon: string;
  title: string;
  /** One sentence, plain language, on what is about to happen. */
  hook: string;
  /**
   * Roughly how many ticks it needs to play out, measured across seeds rather
   * than guessed. Used only to warn that a story is a long one — progress is
   * shown against beats completed, because the cascades finish far faster
   * than a newcomer can read them and a tick bar sitting at 5% would say the
   * opposite of the truth.
   */
  ticks: number;
  setup: (engine: SimulationEngine) => void;
  beats: Beat[];
}

/** Whichever segment the newest collision happened on. */
const crashSegment = (s: SimulationState, base: Baseline) =>
  s.collisions.length > base.collisions ? s.collisions[s.collisions.length - 1].segment_id : null;

export const SCENARIOS: Scenario[] = [
  // ------------------------------------------------------------ collision
  {
    id: "collision",
    icon: "💥",
    title: "A crash, and everything that follows",
    hook: "Two cars collide. Watch the warning reach the traffic behind before any driver could possibly see the wreck — then watch an ambulance get a clear run to it.",
    ticks: 12,
    setup: (engine) => {
      const info = engine.triggerCollision();
      if (info) engine.dispatchAmbulanceTo(info.segment_id.split("_")[0]);
    },
    beats: [
      {
        text: "Two cars collide and block the lane",
        detail: "Both vehicles go immobile and the road is marked hazardous.",
        done: (s, b) => s.collisions.length > b.collisions,
      },
      {
        text: "The wrecks broadcast what happened",
        detail: "DENM, causeCode 2 (accident), confidence 1.0 — the sender is the accident.",
        done: (s, b) => frames(s, "DENM") > b.denm && s.vehicles.some((v) => v.crashed),
      },
      {
        text: "Cars behind are told before they can see it",
        detail: "The frame travels at radio speed; line of sight is irrelevant.",
        done: (s, b) => s.alerts.alerts_delivered > b.alertsDelivered || s.total_reroutes > b.reroutes,
      },
      {
        text: "Independent witnesses agree — the network believes it",
        detail: "Corroboration turns one report into a confirmed incident, so a single liar cannot fake one.",
        done: (s, b) => {
          const seg = crashSegment(s, b);
          return !!seg && (s.segments.find((x) => x.id === seg)?.confirmed_incident ?? false);
        },
      },
      {
        text: "An ambulance is dispatched to the scene",
        done: (s) => s.vehicles.some((v) => v.kind === "ambulance"),
      },
      {
        text: "Traffic ahead pulls over for it",
        detail: "A DENM announcing an emergency vehicle, with its predicted path attached.",
        optional: true,
        done: (s) => s.vehicles.some((v) => v.yielding),
      },
      {
        text: "Junctions turn green ahead of it",
        detail:
          "SREM asks over the air, SSEM answers. Priority is only requested for junctions within the corridor's lookahead, and the ask itself can be lost — so this depends on where the signals fall along the route.",
        optional: true,
        done: (s, b) => s.signal_priority.granted > b.sremGranted,
      },
    ],
  },

  // ----------------------------------------------------------- pedestrian
  {
    id: "pedestrian",
    icon: "🚶",
    title: "Seeing around a corner",
    hook: "Someone steps onto a crossing. One car can see them; a car turning in from the next street cannot. Watch the blind car slow down anyway.",
    ticks: 10,
    setup: (engine) => {
      engine.spawnPedestrian();
    },
    beats: [
      {
        text: "A pedestrian steps onto a crossing",
        done: (s) => s.pedestrians.length > 0,
      },
      {
        text: "The car that can see them brakes hard",
        detail: "Line of sight is limited to the road being crossed — that limit is the whole point.",
        done: (s) => s.vehicles.some((v) => v.braking) || s.pedestrians.some((p) => p.seen_by.length > 0),
      },
      {
        text: "It warns the traffic behind it instantly",
        detail: "DENM causeCode 99 / subCauseCode 1 — emergencyElectronicBrakeEngaged.",
        done: (s, b) => s.perception.brake_warnings > b.brakeWarnings,
      },
      {
        text: "It shares what its sensors can see",
        detail: "CPM (ETSI TS 103 324). The frame grows 35 bytes per object — this is a bandwidth trade, not a free win.",
        done: (s, b) => s.perception.shared > b.shared,
      },
      {
        text: "A car with no line of sight slows for them too",
        detail: "It has never seen the pedestrian. Without the radio it would arrive at the corner at full speed.",
        done: (s, b) => s.perception.warned_blind > b.warnedBlind || s.pedestrians.some((p) => p.known_by.length > 0),
      },
    ],
  },

  // --------------------------------------------------------- traffic light
  {
    id: "glosa",
    icon: "🚦",
    title: "Arriving on green",
    hook: "Junctions broadcast what their lights are about to do. A car that hears “red” ahead eases off early and rolls through instead of racing up and stopping.",
    ticks: 26,
    setup: () => {
      // Nothing to stage: signals broadcast on their own duty cycle. This
      // scenario is about noticing something already happening.
    },
    beats: [
      {
        text: "A junction broadcasts its signal phase",
        detail: "SPaT (ETSI TS 103 301), sent by the roadside unit at the junction.",
        done: (s, b) => frames(s, "SPATEM") > b.spatem,
      },
      {
        text: "Approaching cars actually receive it",
        detail: "Transmitting is not delivering — only vehicles that decoded the frame know the phase.",
        done: (s, b) => frames(s, "SPATEM") > b.spatem + 2,
      },
      {
        text: "A car hears “red” on the junction it is approaching",
        done: (s) => s.traffic_lights.some((l) => l.phase === "red"),
      },
      {
        text: "It holds a slower speed instead of braking late",
        detail: "The advice is never faster than carrying on, and a phase heard long ago is discarded as stale.",
        done: (s) => s.perception.glosa_active > 0,
      },
    ],
  },

  // ------------------------------------------------------------- attacker
  {
    id: "attacker",
    icon: "😈",
    title: "A liar joins the network",
    hook: "A vehicle starts reporting crashes on roads that are perfectly clear. Watch the network work out that it cannot be believed — without any central authority telling it so. This one is deliberately the slowest story here.",
    ticks: 240,
    setup: (engine) => {
      engine.spawnVehicle("malicious");
      engine.spawnVehicle("malicious");
    },
    beats: [
      {
        text: "An attacker joins and starts lying",
        done: (s) => s.vehicles.some((v) => v.kind === "malicious"),
      },
      {
        text: "It reports hazards on roads that are clear",
        done: (s, b) => frames(s, "DENM") > b.denm,
      },
      {
        text: "No independent witness backs it up",
        detail: "A report is only believed when vehicles that could actually have seen it agree.",
        done: (s) =>
          Object.entries(s.trust).some(
            ([id, t]) =>
              id.startsWith("malicious") && t.reports_seen > 2 && t.reports_corroborated < t.reports_seen,
          ),
      },
      {
        text: "Its trust score starts falling",
        detail: "An exponential moving average over how often its reports are corroborated.",
        done: (s) =>
          Object.entries(s.trust).some(([id, t]) => id.startsWith("malicious") && t.trust_score < 0.6),
      },
      {
        text: "It drops below the threshold for being believed",
        detail: "Its reports now carry almost no weight in what the network concludes, or in what the models train on.",
        optional: true,
        done: (s) =>
          Object.entries(s.trust).some(([id, t]) => id.startsWith("malicious") && t.trust_score < 0.25),
      },
      {
        text: "Its certificate is revoked and it is ignored entirely",
        detail:
          "Needs at least 10 reports AND trust below 0.12, so it takes a few minutes of simulated time. That slowness is deliberate: wrongly revoking an honest vehicle is worse than tolerating a liar for a while, and nothing here lets an operator revoke by decree.",
        optional: true,
        done: (s, b) => s.security.pseudonyms.revoked_vehicles > b.revoked,
      },
    ],
  },

  // --------------------------------------------------------- cloud outage
  {
    id: "outage",
    icon: "📵",
    title: "The cloud goes down",
    hook: "The whole point of pushing intelligence to the roadside: cut the connection to the data centre and the safety system keeps working.",
    ticks: 8,
    setup: (engine) => {
      engine.setCloudOnline(false);
    },
    beats: [
      {
        text: "The uplink to the data centre is severed",
        done: (s) => !s.cloud_online,
      },
      {
        text: "Vehicles keep talking directly to each other",
        detail: "CAM and DENM ride the sidelink radio, which never touched the cloud.",
        done: (s, b) => frames(s, "DENM") + frames(s, "CAM") > b.denm + 1,
      },
      {
        text: "Roadside units keep predicting congestion on their own",
        done: (s) => s.rsus.some((r) => r.alive && Object.keys(r.predictions).length > 0),
      },
      {
        text: "Safety messaging stays up",
        detail: "On the centralized baseline this is where the service goes dark — switch architecture on the control centre to see that.",
        done: (s) => s.metrics.resilience.availability_during_outage_pct > 0,
      },
    ],
  },

  // ---------------------------------------------------- federated learning
  {
    id: "federated",
    icon: "🧠",
    title: "The city learns without sharing its data",
    hook: "Each roadside unit trains on what it sees. Only the trained weights are uploaded, never the raw traffic — so the model improves and the data never leaves the street.",
    ticks: 24,
    setup: () => {
      // Federated rounds run on their own schedule; this scenario surfaces
      // something continuous rather than triggering an event.
    },
    beats: [
      {
        text: "Each roadside unit trains on its own local traffic",
        done: (s) => s.rsus.some((r) => r.fl.pending_samples > 0 || r.fl.samples_contributed > 0),
      },
      {
        text: "Only model weights are uploaded — never raw data",
        detail: "Weights are a few kilobytes; the observations behind them would be hundreds.",
        done: (s, b) => s.federated.rounds_completed > b.flRounds,
      },
      {
        text: "The weights are averaged into one shared model",
        detail: "Weighted by how much data each unit had, and by how much its data is trusted.",
        done: (s, b) => s.federated.rounds_completed > b.flRounds,
      },
      {
        text: "The shared model predicts better than it started",
        done: (s) => s.federated.loss_reduction_pct > 0,
      },
      {
        text: "Raw telemetry that never had to be transmitted",
        detail: "This is the privacy and bandwidth argument, measured rather than asserted.",
        done: (s, b) => s.federated.total_raw_kilobytes_avoided > b.rawKbAvoided,
      },
    ],
  },
];

export const SCENARIOS_BY_ID = new Map(SCENARIOS.map((s) => [s.id, s]));

/** "Everything at once" — the whole city doing all of it together. */
export const EVERYTHING: Scenario = {
  id: "everything",
  icon: "🌆",
  title: "Everything at once",
  hook: "A crash, a pedestrian, a liar and a cloud outage, all in the same city at the same time. This is what the numbers on the control centre are actually made of.",
  ticks: 80,
  setup: (engine) => {
    const info = engine.triggerCollision();
    if (info) engine.dispatchAmbulanceTo(info.segment_id.split("_")[0]);
    engine.spawnPedestrian();
    engine.spawnVehicle("malicious");
  },
  beats: [
    { text: "Two cars collide", done: (s, b) => s.collisions.length > b.collisions },
    { text: "A pedestrian is shared by radio", done: (s, b) => s.perception.shared > b.shared },
    {
      text: "A car is warned about someone it cannot see",
      done: (s, b) => s.perception.warned_blind > b.warnedBlind,
    },
    { text: "The incident is corroborated and confirmed", done: (s) => s.segments.some((x) => x.confirmed_incident) },
    {
      text: "An ambulance gets priority at a junction",
      optional: true,
      done: (s, b) => s.signal_priority.granted > b.sremGranted,
    },
    { text: "A car holds a speed to catch a green light", done: (s) => s.perception.glosa_active > 0 },
    {
      text: "The attacker's trust falls",
      done: (s) => Object.entries(s.trust).some(([id, t]) => id.startsWith("malicious") && t.trust_score < 0.7),
    },
    { text: "The roadside units complete a learning round", done: (s, b) => s.federated.rounds_completed > b.flRounds },
  ],
};

export const ALL_SCENARIOS = [...SCENARIOS, EVERYTHING];
