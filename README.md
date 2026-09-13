# Intelligent Decentralized V2X Ecosystem

**Using Edge Intelligence, Federated Learning and Digital Twin Technology for Intelligent Transportation**

B.Tech CSE — Project-I

| Team | Reg. No |
| --- | --- |
| Rahul Anand Y | 23BCE1650 |
| Trilochan P | 23BCE1889 |
| Vijay P | 23BCE5025 |

**Mentor:** Dr. Malathi

---

## What this is

A working, runnable implementation of a decentralized Vehicle-to-Everything
architecture — not a slide deck and not a mock-up. Vehicles detect hazards on
board and gossip them peer-to-peer, roadside units run their own congestion
inference at the edge, the regional model is trained by federated averaging
without any raw telemetry leaving the roadside, a digital twin mirrors the city,
and the whole thing keeps working when the cloud uplink is cut.

The website is the product: a live control centre over the running simulation, a
federated-learning monitor, a security console, and an experiment harness that
runs the three architectures from the project design head-to-head and reports the
measured differences.

### The problem it addresses

Existing ITS and connected-vehicle deployments provide capable V2X communication,
but the placement of intelligence in the network creates four practical failures:

1. **Cloud dependency** — decisions route through a central service, so losing the
   uplink loses the service.
2. **Latency where it matters** — a hazard 200 m ahead cannot wait for a data-centre
   round trip.
3. **Raw telemetry exposure** — continuous per-vehicle position upload is expensive
   and creates a permanent movement record.
4. **No regional context at the edge** — purely local V2V decisions cannot anticipate
   congestion two streets away.

## Measured results

From the built-in experiment harness (normal traffic, 250 ticks, seed 4242, with a
scripted cloud outage in every run):

| Metric | Exp 1 — Centralized | Exp 3 — Proposed | Change |
| --- | --- | --- | --- |
| Hazard-to-warning latency | 28.75 ticks | 1.75 ticks | **−94%** |
| Cloud uplink overhead | 5.05 KB/tick | 0.32 KB/tick | **−94%** |
| Availability during cloud outage | 0% | 100% | **+100 pts** |
| Federated rounds completed | 0 | 14 | — |
| Raw telemetry avoided by FL | — | 160.8 KB | — |

**Average trip time does not separate meaningfully**, and under heavy congestion the
rerouting configurations are occasionally marginally worse. That is a real finding,
not a measurement artefact: each vehicle reroutes greedily on peer reports, so a
widely announced jam can send them all onto the same alternative — the herding
effect congestion-responsive routing is known to produce in the field. Numbers vary
by seed; run several and report the spread.

## Running it

Requires Python 3.11+ and Node 18+.

### Backend

```bash
cd backend
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\Activate.ps1
pip install -r requirements.txt
python -m uvicorn app.main:app --reload --port 8000
```

The first start fits the centralized baseline model, which takes a few seconds,
then the simulation begins ticking and streaming state over
`ws://localhost:8000/ws/state`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open <http://localhost:5173>. The dev server proxies `/api` and `/ws` to port 8000.

### Tests

```bash
cd backend && source .venv/bin/activate && pytest
```

62 tests covering the radio model, corroboration and trust, federated averaging,
pseudonym rotation and replay defence, the metrics collector, the experiment
harness and the HTTP API.

## The site

| Page | What it shows |
| --- | --- |
| **Overview** | The problem, the architecture, and an honest statement of scope |
| **Control Centre** | Live digital-twin map; inject hazards, dispatch ambulances, inject attackers, kill RSUs, sever the cloud uplink, switch the live architecture |
| **Federated Learning** | Round-by-round convergence, per-RSU client state, the global model's weights, and the bandwidth/privacy comparison |
| **Security & Trust** | Pseudonym rotation stats, replay defence, live trust scores, and a replay-attack button |
| **Experiments** | Runs all three architectures on a chosen scenario and charts the comparison |
| **Architecture** | The six layers and twelve modules, each mapped to the file that implements it |

## Repository layout

```
backend/
  app/
    simulation/   world, vehicles, RSUs, fog nodes, traffic lights, digital twin, engine
    network/      messages, gossip radio, corroboration, trust, pseudonyms, RSU topology
    ai/           feature engineering, synthetic corpus, centralized model, federated learning
    decisions/    relevance filtering and alert dispatch
    emergency/    predictive emergency corridors
    experiments/  the Exp1/Exp2/Exp3 harness
    api/          REST + WebSocket
  tests/
frontend/
  src/pages/      the six pages
  src/components/ map, panels, charts
docs/
  ARCHITECTURE.md  design decisions and honest trade-offs
  EXPERIMENTS.md   methodology, metric definitions, how to reproduce
  ROADMAP.md       what a real deployment would still need
```

## Scope, stated honestly

This is a simulation of the proposed architecture. The physical layer is *modelled*
— hop-limited broadcast with a density-dependent loss model — rather than
implemented over licensed-spectrum C-V2X hardware, and the security layer uses
HMAC-based certificates in place of a full IEEE 1609.2 PKI. Traffic is a synthetic
grid city, not an imported road network.

Everything above that line is real code that runs and is measured: on-board event
detection, peer-to-peer dissemination with TTL and dedup, edge inference, FedAvg
over per-RSU local training, digital-twin synchronization and divergence,
corroboration-based trust with density awareness, pseudonym rotation, replay
defence, and the comparative evaluation.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for the reasoning behind each
design decision and [`docs/ROADMAP.md`](docs/ROADMAP.md) for what deployment-grade
work remains.
