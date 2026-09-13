# Experimental evaluation

## Configurations

| | Exp 1 — Centralized | Exp 2 — V2X, no edge AI | Exp 3 — Proposed |
| --- | --- | --- | --- |
| Direct V2V | no | yes | yes |
| Edge AI at RSU | no | no | yes |
| Federated learning | no | no | yes |
| Digital twin sync | yes | no | yes |
| Predictive rerouting | no | yes | yes |
| Cloud round trip | 6 ticks | 3 ticks | 0 ticks |
| Fails without cloud | yes | no | no |

All three run on the same engine with the same seed and the same scenario, so the
only independent variable is the architecture.

## Scenarios

| Key | Description |
| --- | --- |
| `normal` | Steady flow, 26 vehicles, organically occurring hazards |
| `congestion` | 44 vehicles — more than the grid comfortably carries |
| `emergency` | 30 vehicles plus 2 ambulances needing corridors |
| `attack` | 30 vehicles plus 4 attackers injecting false hazard reports |

Every run includes a scripted cloud outage between 55% and 75% of the run, which is
how availability under disruption is measured.

## Metric definitions

### Communication

- **Hazard-to-warning latency** — ticks from a hazard physically appearing to a
  warning reaching a vehicle whose route crosses that segment. This is end-to-end:
  sensing, dissemination, corroboration, relevance filtering and delivery, including
  any cloud round trip.
- **Detection latency** — ticks from the hazard appearing to the network corroborating
  it (delivery excluded).
- **Packet delivery ratio** — delivered receptions over intended receptions, under a
  loss model where probability falls with hop distance and local transmitter density.
- **Uplink overhead (KB/tick)** — backhaul traffic only: raw telemetry uploads, RSU
  digests, digital-twin sync and federated weight exchange.
- **Local radio (KB/tick)** — sidelink V2V/V2I traffic. Reported separately because
  it is a different resource.

### Traffic impact

- **Average trip time** — ticks per completed journey.
- **Congestion duration** — percentage of (segment, tick) samples at or above 0.7
  occupancy.

### Detection quality

Scored against the **physical** hazard state, never the network's belief.

- **Precision** — corroborated incidents that were real, over all corroborated
  incidents. A configuration that confirms a fabricated hazard is penalised.
- **Recall** — hazard episodes detected before they cleared, over all episodes.
- **F1** — harmonic mean.

### Federated learning

- **Rounds completed**, **loss reduction %** against a held-out validation corpus the
  clients never train on.
- **Convergence round** — first round reaching 25% of the initial loss.
- **Raw KB avoided** — what shipping the training samples would have cost, versus the
  weights actually exchanged.

### Resilience

- **Availability** — percentage of ticks where safety messaging functioned.
- **Availability during outage** — the same, restricted to the scripted outage window.
  This is the number that separates the architectures most starkly.

## Reproducing

From the website: **Experiments → choose a scenario → Run the sweep.** Three full
simulations take a few seconds.

From the API:

```bash
curl -X POST localhost:8000/api/experiments/run \
  -H 'Content-Type: application/json' \
  -d '{"scenario":"normal","ticks":250,"seed":4242}'
```

From Python:

```python
from app.experiments.runner import run_suite
suite = run_suite("congestion", ticks=300, seed=17)
```

## Interpreting the results

**Use 250 ticks or more.** Shorter runs may contain too few hazard episodes to
produce a stable latency or recall figure.

**Vary the seed.** Latency, uplink overhead and availability aggregate over every
tick and are stable. Precision and recall depend on a handful of hazard episodes and
move several points between seeds — for anything quoted in a report, run several
seeds and give the spread rather than a single number.

**Expect trip time not to separate.** See the limitations section of
`ARCHITECTURE.md`: greedy independent rerouting produces herding. Reporting this
honestly is more defensible than tuning the threshold until the number looks good.
