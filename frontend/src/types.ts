export interface SegmentState {
  id: string;
  a: string;
  b: string;
  occupancy: number;
  incident: boolean;
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

export interface SimulationState {
  tick: number;
  grid_size: number;
  messages_this_tick: number;
  segments: SegmentState[];
  vehicles: VehicleState[];
  rsus: RsuState[];
  traffic_lights: TrafficLightState[];
  trust: Record<string, TrustEntry>;
  cloud_digests: CloudDigest[];
  handovers: Handover[];
  corridor_events: { tick: number; type: string; ambulance_id: string }[];
  active_corridors: string[];
  events: EventEntry[];
}
