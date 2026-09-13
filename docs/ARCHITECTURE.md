# Architecture

## Framing

This project is designed as a scalable architecture intended to overcome specific,
named limitations of existing V2X deployments. It is not claimed to be superior in
deployment to Tesla's connected network, Qualcomm C-V2X or Mobileye — those are
shipping products on licensed spectrum with millions of road miles behind them.
What is claimed, and demonstrated with measurements, is that placing intelligence
at the vehicle and the roadside instead of in a central cloud produces materially
lower warning latency, an order-of-magnitude lower uplink cost, and continuity of
service through a cloud outage.

## Layer model

```
L6  Applications          alerts, dashboards, route guidance
L5  Digital twin & cloud  city-wide state, historical analytics, model management
L4  Distributed intell.   federated aggregation, traffic prediction
L3  Intelligent edge      RSUs, edge AI, local decision engine
L2  Vehicular comms       V2V, V2I/V2R, V2N
L1  Physical / sensing    vehicles, GNSS, road sensors
```

Information flows up and decisions flow back down, but no single layer is a point
of failure. L1–L3 continue operating with L5 unreachable, which is what the outage
experiment measures rather than asserts.

## Module map

| Module | Responsibility | Source |
| --- | --- | --- |
| M1 | Vehicle data acquisition | `app/simulation/vehicle.py` |
| M2 | V2X communication manager | `app/network/gossip.py`, `app/network/messages.py` |
| M3 | Event & hazard detection | `app/simulation/vehicle.py` |
| M4 | Intelligent RSU edge | `app/simulation/rsu.py` |
| M5 | Traffic-state estimation | `app/simulation/rsu.py`, `app/simulation/world.py` |
| M6 | Predictive intelligence | `app/ai/congestion_model.py` |
| M7 | Federated learning | `app/ai/federated.py` |
| M8 | Transport digital twin | `app/simulation/digital_twin.py` |
| M9 | Decision & alert engine | `app/decisions/alerts.py` |
| M10 | Emergency coordination | `app/emergency/corridor.py` |
| M11 | Security & trust | `app/network/pseudonyms.py`, `security.py`, `corroboration.py` |
| M12 | Visualization dashboard | `frontend/src/pages/` |

## Design decisions, and what each one costs

### Ground truth is kept separate from belief

`Segment` carries both `hazard_active` (a hazard physically exists) and
`confirmed_incident` (the network has corroborated one). Collapsing these into one
field — the obvious first implementation — makes hazard precision and recall
tautologically perfect, because the system's belief *is* the truth it is scored
against. Keeping them apart is what makes the detection metrics mean anything, and
it is why the map draws them as two separate overlays: you can see a missed hazard
and a false confirmation.

### One engine, three architectures

Rather than maintaining three code paths, `ArchitectureConfig` switches individual
capabilities (`v2v_enabled`, `rsu_edge_ai`, `federated_learning`,
`digital_twin_sync`, `predictive_rerouting`, `cloud_round_trip_ticks`,
`cloud_dependent`). The same engine, traffic and seed produce all three
experimental configurations, so a difference in the results is attributable to the
architecture rather than to divergent code.

### The radio is modelled, not simulated

Physical range is approximated by hop distance on the road graph, with delivery
probability falling off per hop and with local transmitter density. That
contention term is deliberate: "communication reliability in dense environments"
is one of the problems the project identifies, and without it packet delivery
ratio would be 1.0 by construction and meaningless. What this does *not* model is
PHY-layer behaviour — fading, modulation, the actual 802.11p/PC5 MAC.

### Federated learning uses a linear model on purpose

FedAvg over a linear regressor is *exactly* the sample-weighted mean of the
clients' parameters, so the aggregation step can be verified by hand in a viva and
is asserted directly in `tests/test_federated.py`. It also trains on a laptop CPU
in milliseconds. The cost is representational power versus a deep model; the
serving interface is shared with the centralized predictor so a stronger model can
be dropped in without touching callers.

The client's sample buffer is private to the client object and cleared after each
round. The coordinator receives a weight vector and a sample count — nothing else.

### Uplink and local radio are counted separately

They are different finite resources and summing them would be misleading. The
project's bandwidth and privacy objections are specifically about *raw telemetry on
the uplink*, so that is what the headline overhead metric reports. A design that
chatters locally to avoid the uplink is making a trade, not paying twice — and the
full metric table shows both numbers so the trade is visible.

### Trust scoring is density-aware

"Nobody confirmed this report" and "nobody was *able* to confirm this report" look
identical in the data and mean opposite things. Scoring them the same way steadily
destroys the reputation of honest vehicles on quiet streets — which is exactly what
the first implementation did, revoking honest cars' certificates. A report no other
vehicle was positioned to witness now leaves trust untouched. Repeated reports of
the same hazard by the same vehicle are also collapsed into one observation, because
a car sitting in a jam re-reports it every tick and should not be bankrupted for it.

### Pseudonym rotation without losing accountability

Rotating identifiers often enough to defeat roadside tracking normally destroys the
long-lived identity misbehaviour detection depends on. The split modelled here is
the one real C-V2X deployments use: RSUs verify that a pseudonym was validly issued
but cannot link two pseudonyms to the same vehicle, while a separate misbehaviour
authority holds the mapping and accumulates evidence against the durable identity.
Rotation therefore does not launder a bad reputation.

Revocation uses a much lower threshold than soft quarantine, and requires a minimum
number of observed reports. Wrongly revoking an honest vehicle is a far worse
failure than tolerating a noisy one for a few more ticks.

### Congestion actually slows vehicles

Vehicle speed follows a Greenshields-style speed/density relation. Without it,
sitting in a jam is free, every detour is pure loss, and congestion-aware rerouting
can only ever look harmful regardless of how well it works. This is a fidelity
requirement for the traffic-impact metric to be interpretable at all.

## Known limitations

- **Rerouting is greedy and uncoordinated.** Vehicles decide independently on peer
  reports, which produces herding onto the same alternative route. This is why trip
  time does not improve; fixing it requires coordinated assignment.
- **Detection recall is sensitive to vehicle density.** A hazard on an empty street
  is not detected until someone drives past — realistic, but it makes recall noisy
  at low episode counts.
- **Sybil attacks are not defended.** Several colluding nodes can corroborate each
  other's fabrications. Defeating that needs certificate-issuance limits bound to a
  real identity.
- **The city is synthetic.** A grid, not an imported road network, so absolute trip
  times are not comparable to a real city's.
