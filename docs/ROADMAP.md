# Roadmap

What a deployment-grade version of this system would still need. Everything here is
future work relative to what is implemented today; see `ARCHITECTURE.md` for the
current state.

## Near term — extends the existing code directly

- **Coordinated rerouting.** The single clearest negative result in the current
  evaluation: independent greedy rerouting produces herding and does not improve
  trip time. Replacing per-vehicle greedy choice with assignment coordinated at the
  RSU or fog tier is the obvious next experiment.
- **Graph neural network for congestion forecasting.** The current model uses
  engineered spatio-temporal features; a GNN over the road graph would capture
  propagation between segments directly. `CongestionPredictor.predict` is already
  the seam.
- **Secure aggregation for federated learning.** Weights alone can still leak
  information about the training data. Adding secure aggregation or differential
  privacy would close that gap and is a natural extension of `federated.py`.
- **Sybil resistance.** Bind certificate issuance to a hardware root of trust and cap
  concurrent pseudonyms per real identity, so colluding nodes cannot manufacture
  corroboration for each other.
- **Penetration-rate sweep.** Detection recall clearly depends on how many vehicles
  participate. Sweeping equipped-vehicle percentage would produce a useful curve and
  an honest answer to "how many cars need this before it works?".

## Mid term — needs real infrastructure or data

- **Real road networks.** Import OpenStreetMap geometry instead of a synthetic grid,
  so trip times and congestion figures are comparable to a real city.
- **SUMO / OMNeT++ / Veins co-simulation.** Validate the modelled radio behaviour
  against an established network simulator rather than the abstraction used here.
- **IEEE 1609.2 PKI.** Replace HMAC pseudonym certificates with real certificate
  chains and an SCMS-style misbehaviour authority.
- **Physical edge nodes.** Run the RSU software on Raspberry Pi or Jetson hardware to
  measure real inference latency and power draw at the edge.
- **Cooperative perception.** Share sensor observations, not just events, to extend
  line of sight past occlusions.

## Long term — research scale

- **City-scale digital twin** synchronized against live feeds, with what-if
  forecasting rather than short-horizon prediction.
- **Multi-agent reinforcement learning** for joint signal timing and lane allocation
  across many intersections.
- **Formal security evaluation** — red-team the trust and corroboration system against
  coordinated adversaries, not just the single bad actor demonstrated today.
- **Sustainability objectives** — optimize fuel, battery and emissions jointly with
  congestion and safety rather than treating them as a side effect.
