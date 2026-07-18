# Roadmap: from prototype to deployment-grade

Everything here is future work relative to what's implemented today
(see `ARCHITECTURE.md` for the current subset). Presenting this as roadmap
rather than shipped capability is the credible framing for a capstone
report and viva.

## Near-term (extends the current prototype directly)

- **Swap the congestion model for a Graph Neural Network / Transformer**
  trained on real (or higher-fidelity simulated, e.g. SUMO) trajectory data.
  `CongestionPredictor.predict(segment, tick)` is already the seam to swap
  behind.
- **Density-aware trust scoring.** Fold in local vehicle density so a lone
  honest reporter in a sparse area isn't scored the same as a report nobody
  around could have corroborated even if they wanted to.
- **Federated learning across vehicles.** Replace the single shared model
  trained once at startup with local on-device training rounds that
  exchange only model updates (not raw sensor data) between vehicles and
  RSUs, aggregated periodically -- true federated learning rather than a
  single pre-shared model.
- **Real PKI / IEEE 1609.2 signing** in place of the simulated per-process
  HMAC certificates, plus a blockchain- or DAG-based distributed trust
  ledger so trust scores survive beyond a single RSU's memory.

## Mid-term (needs real infrastructure or data)

- **Multi-agent reinforcement learning** for cooperative signal timing and
  lane allocation across many intersections simultaneously, instead of the
  current fixed-cycle + emergency-preemption traffic lights.
- **Swarm-intelligence rerouting** (ant-colony / flocking-inspired) so
  hazard response reorganizes traffic at a neighborhood scale, not just
  per-vehicle yield instructions.
- **Digital twin fidelity**: replace the synthetic grid with a real road
  network (OpenStreetMap import), real weather feeds, and construction/
  incident data sources.
- **Driver behavior analysis** (aggressive driving, fatigue, erratic
  steering) via sensor fusion, feeding into both the trust score and safety
  alerts.
- **Infrastructure health monitoring**: RSUs and vehicles cooperatively
  detect road damage and signal-hardware failures from ride telemetry.

## Long-term (research-grade / ecosystem-scale)

- **City-scale digital twin** simulating every vehicle, pedestrian crossing,
  weather station, and construction site, run continuously against live
  data feeds for what-if forecasting.
- **Decentralized service marketplace**: parking sharing, EV charging
  reservation, sensor-data marketplace, with a credit/incentive system for
  contributing vehicles.
- **Sustainability optimization**: joint optimization of fuel/battery usage
  and citywide emissions as a first-class objective alongside congestion and
  safety.
- **Formal security evaluation**: red-team the trust/corroboration system
  against coordinated Sybil and collusion attacks (multiple malicious
  vehicles corroborating each other), not just the single-bad-actor case
  demonstrated today.
