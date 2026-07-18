# Architecture

## Scope and framing

This project is designed as a scalable architecture intended to overcome key
limitations of existing V2X systems (cloud dependency, passive vehicles,
reactive-only views, no collective intelligence) -- it is not presented as
already superior in deployment to Tesla's connected network, Qualcomm C-V2X,
or Mobileye. The implementation below covers a demonstrable subset of the
full vision; the rest is documented as a future-work roadmap
(see `ROADMAP.md`), which is the credible framing for a capstone project.

## System layers

```
Vehicle Sensors -> Vehicle AI Agent -> Nearby Vehicles (V2V gossip + occupancy sharing, local rerouting)
                                    -> RSU Edge Server (edge AI, self-healing cell handover)
                                    -> Fog Node (regional aggregation across an RSU cluster)
                                    -> Cloud digest (bandwidth-bounded regional summary)
Emergency corridor manager reaches across all layers when an ambulance is present.
```

The cloud is one layer among many, not the brain: every layer above it can
keep functioning on its own if the layers above go away. The fog tier adds a
second hop of bandwidth reduction and lets the network reason across RSU
cell boundaries (a single RSU can't see that its neighbor is jammed too; its
fog node can).

## Module map (`backend/app/`)

| Module | Responsibility |
| --- | --- |
| `simulation/world.py` | Synthetic city grid (N x N intersections + road segments), shortest-path routing, occupancy history |
| `simulation/vehicle.py` | Vehicle agent: movement, hazard sensing, gossip message authoring. Includes a `malicious` kind that fabricates hazard reports, giving the trust layer something real to catch |
| `simulation/rsu.py` | RSU edge node: local congestion inference, cloud digest generation |
| `simulation/fog.py` | Fog computing tier: clusters RSUs geographically, aggregates their digests into a regional summary, raises a regional congestion alert |
| `simulation/traffic_light.py` | Intersection signal with a normal cycle and an emergency-preemption override |
| `simulation/engine.py` | Orchestrates one simulation tick across every layer below |
| `network/messages.py` | Wire message schema (hazard report, occupancy ping, congestion digest, emergency broadcast, yield instruction) |
| `network/gossip.py` | `EtherBus`: V2V epidemic (flood/TTL) relay with per-node dedup, modeling physical radio range as hop-distance on the road graph |
| `network/corroboration.py` | Network-wide hazard corroboration: independent confirmation flips a segment's incident flag and updates trust |
| `network/security.py` | Simulated per-vehicle certificates (HMAC signing) and a corroboration-rate-based trust registry |
| `network/rsu_network.py` | RSU topology, self-healing cell handover, cloud digest storage |
| `ai/congestion_model.py` | Edge-deployable congestion forecaster + occlusion-based local explanation |
| `emergency/corridor.py` | Predictive emergency corridor: route lookahead, light preemption, yield instructions |
| `api/` | FastAPI REST + WebSocket surface consumed by the dashboard |

## Design decisions and honest trade-offs

**Decentralized messaging as graph-hop flooding.** Real DSRC/C-V2X radios
have a physical range and messages hop vehicle-to-vehicle with a TTL to go
further. We approximate physical range with hop-distance on the road graph
(a message published at intersection X reaches every intersection within
`ttl` hops), which preserves the real properties being demonstrated -- bounded
relay, dedup, no single point of failure -- without simulating radio-layer
physics.

**Congestion forecasting: gradient-boosted regressor, not a GNN/LSTM.**
Production-grade V2X research forecasts congestion with graph neural
networks or LSTMs over real historic telemetry. We do not have real
trajectory data or GPU training budget here, so the edge model is a
`GradientBoostingRegressor` over engineered spatio-temporal features (lag
occupancy, diurnal phase, live incident flag, neighboring-segment pressure),
trained on a procedurally generated synthetic traffic corpus. The
feature/serving interface (`CongestionPredictor.predict`) is written so a GNN
can be swapped in later without touching any caller -- see `ROADMAP.md`.

**Explainable AI via occlusion, not SHAP.** Rather than pull in a SHAP
dependency, `_predict_with_attribution` computes a local (per-sample)
feature attribution by re-predicting with each feature clamped to its
dataset-typical value and measuring the change -- a lightweight counterfactual
explanation. An earlier version used global feature importance weighted by
z-score, which produced the same "dominant driver" on almost every segment
regardless of its actual state, because the diurnal features have far higher
global importance than anything else; occlusion fixed that by measuring what
actually moved *this* prediction.

**Trust scoring: corroboration rate with a minimum sample gate, not a
random walk.** An earlier version penalized every uncorroborated hazard
report by a fixed amount. That crashed honest vehicles' trust to zero simply
because they were the only vehicle near a real incident when it happened --
nobody else was present to corroborate them, so it looked identical to
fabrication. The registry now requires a minimum number of observed reports
before it judges a vehicle at all, and then drifts trust toward the vehicle's
*observed corroboration rate* via exponential smoothing, so one unlucky
report can't zero out a good record and one lucky confirmation can't
launder a bad one. This is still an approximation: a vehicle that is
*always* the lone reporter in a sparse area will trend toward low trust
purely from low corroboration opportunity, not malice. A production system
would fold in local vehicle density so "nobody was around to confirm" and
"everybody around disagreed" are scored differently.

**Fog computing tier: geographic clustering, not a real regional data
center.** `simulation/fog.py` groups RSUs by physical proximity (sorted by
grid coordinate before chunking, so a cluster is a contiguous district, not
an arbitrary set of ids) into `FogNode`s. Each fog node aggregates its
members' occupancy/incident data into one regional summary every
`FOG_INTERVAL_TICKS` and raises a regional alert when the *cluster* average
crosses a threshold -- something no individual RSU can see on its own,
since it only has visibility into its own intersection. In this prototype
the fog node's "action" on alert is limited to logging + a dashboard
highlight; a production system would use it to coordinate signal timing or
load-balance vehicles across the cluster's RSUs, which is a natural
next step (see `ROADMAP.md`).

**V2V congestion sharing uses only messages, never the shared world
state directly.** This is a single-process simulation, so in principle any
vehicle object could just read `grid.segments[...]` and know the occupancy
of every road in the city -- but that would make "decentralized" a lie.
To keep the demonstration honest, a vehicle's `known_occupancy` cache is
populated *exclusively* by `receive_occupancy_ping`, called only when the
message-passing layer (`EtherBus`, with the same hop-limited TTL as hazard
gossip) actually delivers it a peer's `OCCUPANCY_PING`. Rerouting
(`Vehicle._maybe_reroute`) only ever consults that cache, with a staleness
cutoff and a per-vehicle cooldown so a vehicle doesn't thrash between two
routes every tick. The one deliberate exception is a vehicle's *own current*
segment: reading your own physical surroundings isn't remote knowledge, so
that's a direct read, same as the incident-triggered speed penalty. The
practical effect: when a large swath of the city congests at once, many
vehicles can decide to reroute within the same few ticks -- a real
"herding" effect naive congestion-based rerouting is known to cause (this
is the same dynamic behind Waze-induced side-street congestion in the real
world), not a bug in the demo.

**Cybersecurity is simulated, not deployed.** Vehicle "certificates" are
per-vehicle HMAC keys generated in-process (`network/security.py`), and
messages are signed/verified with them. This demonstrates the mechanism
(authenticity, tamper-evidence) without standing up a real PKI, IEEE 1609.2
stack, or blockchain trust ledger -- those are roadmap items.

**Digital twin dashboard renders a synthetic grid, not real map tiles.**
The city is an N x N grid rather than a real road network, so the dashboard
draws it directly as SVG instead of depending on a mapping provider/API key.
The simulation, messaging, and AI logic underneath are provider-agnostic and
would work the same way over a real road graph.
