export interface SegmentState {
  id: string;
  a: string;
  b: string;
  occupancy: number;
  hazard_active: boolean;
  hazard_type: string;
  confirmed_incident: boolean;
}

export interface VehicleState {
  id: string;
  pseudonym: string;
  kind: "car" | "ambulance" | "malicious";
  x: number;
  y: number;
  node: string;
  next_node: string | null;
  destination: string;
  segment_id: string | null;
  yielding: boolean;
  trust_hint: number;
  reroute_count: number;
}

export interface Prediction {
  segment_id: string;
  current_occupancy: number;
  predicted_occupancy: number;
  horizon_ticks: number;
  risk_level: "low" | "moderate" | "high";
  top_factor: string;
  top_factor_contribution: number;
  explanation: string;
  model?: string;
  centralized_reference?: number;
}

export interface RsuState {
  id: string;
  node: string;
  alive: boolean;
  predictions: Record<string, Prediction>;
  cell_size: number;
  messages_handled: number;
  fl: { pending_samples: number; rounds_joined: number; samples_contributed: number; drift: number };
}

export interface FogNodeState {
  id: string;
  x: number;
  y: number;
  member_rsu_ids: string[];
  alert: boolean;
  avg_occupancy: number;
  incident_count: number;
  vehicles_served: number;
}

export interface TrafficLightState {
  id: string;
  node: string;
  phase: "green" | "red";
  preempted: boolean;
  preempt_reason: string;
}

export interface TrustEntry {
  trust_score: number;
  reports_seen: number;
  reports_corroborated: number;
  quarantined: boolean;
}

export interface FederatedRound {
  round: number;
  tick: number;
  participants: string[];
  client_count: number;
  samples_used: number;
  global_loss: number;
  loss_delta: number;
  weights_kilobytes: number;
  raw_kilobytes_avoided: number;
  avg_client_drift: number;
  /** What plain FedAvg would have produced, so the defence is measured. */
  plain_fedavg_loss: number;
  mean_client_trust: number;
  excluded_clients: string[];
}

export interface FederatedState {
  rounds_completed: number;
  initial_loss: number;
  current_loss: number;
  loss_reduction_pct: number;
  convergence_round: number | null;
  total_weights_kilobytes: number;
  total_raw_kilobytes_avoided: number;
  latest_round: FederatedRound | null;
  history: FederatedRound[];
  plain_fedavg_loss: number;
  trust_weighting_gain_pct: number;
  mean_client_trust: number;
  excluded_clients: string[];
  rounds_with_exclusions: number;
  weights: { features: string[]; coefficients: number[]; intercept: number };
}

export interface ArchitectureConfigState {
  key: string;
  label: string;
  summary: string;
  v2v_enabled: boolean;
  rsu_edge_ai: boolean;
  federated_learning: boolean;
  digital_twin_sync: boolean;
  predictive_rerouting: boolean;
  emergency_corridor: boolean;
  cloud_round_trip_ticks: number;
  cloud_dependent: boolean;
}

export interface MetricsSummary {
  communication: {
    packet_delivery_ratio: number;
    avg_detection_latency_ticks: number;
    avg_alert_latency_ticks: number;
    alert_samples: number;
    detection_samples: number;
    messages_sent: number;
    local_kilobytes: number;
    local_kilobytes_per_tick: number;
    uplink_kilobytes: number;
    uplink_kilobytes_per_tick: number;
    /** Frames and bytes by standard designator: CAM, DENM, probe. */
    frames_by_designator: Record<string, number>;
    kilobytes_by_designator: Record<string, number>;
  };
  traffic: {
    segments_per_100_vehicle_ticks: number;
    segment_transitions: number;
    avg_trip_ticks: number;
    trips_completed: number;
    congestion_duration_pct: number;
  };
  detection: {
    precision: number;
    recall: number;
    f1: number;
    true_positives: number;
    false_positives: number;
    hazards_detected: number;
    hazards_missed: number;
  };
  resilience: {
    availability_pct: number;
    availability_during_outage_pct: number;
    outage_ticks: number;
    total_ticks: number;
  };
}

/**
 * One frame's journey, for the close-up view.
 *
 * The fleet dashboard only needs counts; a street-level view has to draw the
 * actual hop from sender to receiver, so the engine records who transmitted
 * what and who decoded it.
 */
export interface Transmission {
  id: string;
  tick: number;
  designator: string;
  type: string;
  sender_id: string;
  origin_node: string;
  delivered_to: string[];
  intended: number;
  segment_id?: string;
  hazard_type?: string;
  cause_code?: number;
}

export interface EventEntry {
  tick: number;
  type: string;
  message: string;
}

export interface SimulationState {
  tick: number;
  grid_size: number;
  config: ArchitectureConfigState;
  cloud_online: boolean;
  messages_this_tick: number;
  kilobytes_this_tick: number;
  reroutes_this_tick: number;
  total_reroutes: number;
  frames_rejected: number;
  segments: SegmentState[];
  vehicles: VehicleState[];
  rsus: RsuState[];
  fog_nodes: FogNodeState[];
  traffic_lights: TrafficLightState[];
  trust: Record<string, TrustEntry>;
  security: {
    pseudonyms: {
      certificates_issued: number;
      rotations: number;
      lifetime_ticks: number;
      avg_pseudonyms_per_vehicle: number;
      revoked_vehicles: number;
      tracked_vehicles: number;
    };
    replay: {
      accepted: number;
      replays_blocked: number;
      stale_dropped: number;
      rejection_rate_pct: number;
      freshness_window_ticks: number;
    };
    /** IEEE 1609.2 / TS 103 097 certificate attachment. */
    certificates: {
      frames_secured: number;
      certificates_attached: number;
      digests_attached: number;
      attach_interval: number;
      kilobytes_saved: number;
    };
  };
  federated: FederatedState;
  digital_twin: {
    syncs: number;
    last_sync_tick: number;
    staleness_ticks: number;
    divergence: number;
    kilobytes_synced: number;
    congested_segments: number;
    tracked_segments: number;
  };
  alerts: {
    alerts_raised: number;
    alerts_delivered: number;
    queued: number;
    cloud_round_trip_ticks: number;
    recent: { tick: number; segment_id: string; reason: string; recipients: number; latency_ticks: number }[];
  };
  metrics: MetricsSummary;
  active_corridors: string[];
  /** SREM/SSEM outcomes. `unheard` is the interesting one. */
  signal_priority: {
    requested: number;
    granted: number;
    unheard: number;
    grant_rate_pct: number;
  };
  handovers: { tick: number; vehicle_id: string; from: string; to: string; reason: string }[];
  /** Recent frames on the air, newest last. Bounded — see the engine. */
  transmissions: Transmission[];
  events: EventEntry[];
}

export interface ExperimentRun {
  config: ArchitectureConfigState;
  scenario: {
    key: string;
    label: string;
    description: string;
    vehicles: number;
    malicious: number;
    ambulances: number;
  };
  ticks: number;
  seed: number;
  metrics: MetricsSummary;
  federated: {
    rounds_completed: number;
    loss_reduction_pct: number;
    convergence_round: number | null;
    raw_kilobytes_avoided: number;
    weights_kilobytes: number;
  };
  digital_twin: { divergence: number; syncs: number; kilobytes_synced: number };
  outage_window: { start: number; end: number };
}

/** A mean with the uncertainty that belongs to it. Mirrors app/stats.py. */
export interface Estimate {
  mean: number;
  half_width: number;
  low: number;
  high: number;
  stdev: number;
  n: number;
  /** One seed is a sample, not a result. */
  reportable: boolean;
}

export interface HeadlineMetric {
  baseline: number;
  baseline_half_width: number;
  proposed: number;
  proposed_half_width: number;
  improvement_pct: number;
  samples: number;
  /** Whether the two 95% intervals actually separate. */
  separated: boolean;
  unit: string;
  label: string;
}

export interface ConfigAggregate {
  config_key: string;
  metrics: Record<string, Estimate>;
}

export interface ExperimentSuite {
  scenario: ExperimentRun["scenario"];
  ticks: number;
  seed: number;
  seeds: number[];
  repeats: number;
  runs: ExperimentRun[];
  aggregates: ConfigAggregate[];
  headline: Record<string, HeadlineMetric>;
}

export interface ReferenceData {
  layers: { id: string; name: string; components: string; function: string; implemented_by: string[] }[];
  modules: { id: string; name: string; description: string; source: string; status: string; notes: string }[];
  team: {
    title: string;
    subtitle: string;
    course: string;
    members: { name: string; reg: string }[];
    mentor: string;
  };
}

export interface Scenario {
  key: string;
  label: string;
  description: string;
  vehicles: number;
  malicious: number;
  ambulances: number;
}
