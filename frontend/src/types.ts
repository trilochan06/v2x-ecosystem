export interface SegmentState {
  id: string;
  a: string;
  b: string;
  occupancy: number;
  /** Physical truth. Only the simulator knows this; no RSU or vehicle can read it. */
  incident: boolean;
  /** What the network corroborated. This is what the infrastructure acts on. */
  reported_incident: boolean;
}

export interface DetectionQuality {
  true_positives: number;
  false_positives: number;
  false_negatives: number;
  precision: number;
  recall: number;
  f1: number;
}

export interface TwinAnomaly {
  tick: number;
  segment_id: string;
  replica_occupancy: number;
  physical_occupancy: number;
  gap: number;
  kind: "occupancy_drift" | "unmodelled_incident" | "phantom_incident";
}

export interface DigitalTwinState {
  synced_tick: number;
  staleness_ticks: number;
  sync_interval: number;
  syncs: number;
  replica_segments: number;
  divergence: number;
  max_segment_gap: number;
  alert: boolean;
  alert_threshold: number;
  divergence_history: number[];
  anomalies: TwinAnomaly[];
  anomaly_count: number;
}

export interface FederatedClientState {
  rsu_id: string;
  buffered_samples: number;
  data_trust: number;
  rounds_joined: number;
  samples_contributed: number;
  drift: number;
  eligible: boolean;
}

export interface FederatedRound {
  round: number;
  tick: number;
  participants: string[];
  excluded: string[];
  samples_used: number;
  global_loss: number;
  plain_loss: number;
  loss_delta: number;
  mean_client_trust: number;
  avg_client_drift: number;
  weights_bytes: number;
  raw_bytes_avoided: number;
}

export interface FederatedState {
  /** MSE of simply predicting the holdout's own mean. */
  baseline_loss: number;
  /** 1 - loss/baseline. Positive means the model beats that baseline. */
  skill: number;
  plain_skill: number;
  rounds_completed: number;
  round_interval: number;
  clients: FederatedClientState[];
  participation_floor: number;
  initial_loss: number;
  current_loss: number;
  loss_reduction_pct: number;
  plain_fedavg_loss: number;
  latest_round: FederatedRound | null;
  history: FederatedRound[];
  total_raw_bytes_avoided: number;
  total_weights_bytes: number;
  holdout_size: number;
}

export interface VehicleState {
  id: string;
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
}

export interface RsuState {
  id: string;
  node: string;
  alive: boolean;
  predictions: Record<string, Prediction>;
  cell_size: number;
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

export interface CloudDigest {
  tick: number;
  rsu_id: string;
  segment_count: number;
  avg_occupancy: number;
  incident_count: number;
  vehicles_served: number;
}

export interface Handover {
  tick: number;
  vehicle_id: string;
  from: string;
  to: string;
  reason: string;
}

export interface EventEntry {
  tick: number;
  type: string;
  message: string;
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

export interface SimulationState {
  tick: number;
  grid_size: number;
  messages_this_tick: number;
  reroutes_this_tick: number;
  total_reroutes: number;
  fog_nodes: FogNodeState[];
  segments: SegmentState[];
  vehicles: VehicleState[];
  rsus: RsuState[];
  traffic_lights: TrafficLightState[];
  trust: Record<string, TrustEntry>;
  federated: FederatedState;
  digital_twin: DigitalTwinState;
  detection: DetectionQuality;
  cloud_digests: CloudDigest[];
  handovers: Handover[];
  corridor_events: { tick: number; type: string; ambulance_id: string }[];
  active_corridors: string[];
  events: EventEntry[];
}
