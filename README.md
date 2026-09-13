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

From the built-in experiment harness (normal traffic, 400 ticks, seed 4242, with a
scripted cloud outage in every run):

| Metric | Exp 1 — Centralized | Exp 3 — Proposed | Change |
| --- | --- | --- | --- |
| Cloud uplink overhead | 4.90 KB/tick | 0.32 KB/tick | **−93%** |
| Availability during cloud outage | 0% | 100% | **+100 pts** |
| Hazard detection F1 | 0.29 | 0.50 | **+0.21** |
| Hazard-to-warning latency | 14.7 ticks | 8.0 ticks | −46% (3–7 samples) |
| Mobility (segments / 100 vehicle-ticks) | 1.240 | 1.279 | +3.1% |
| Federated rounds completed | 0 | 24 | — |
| Raw telemetry avoided by FL | — | 275.6 KB | — |

Read these with the sample sizes in mind. Uplink overhead, availability and
mobility aggregate over every tick and are stable across seeds. Corroborated
alerts are rare — a few per run — so the latency figure moves substantially
between seeds, and the site refuses to headline it below five samples rather than
present a one-sample average as a result. Detection precision and recall depend on
a couple of dozen hazard episodes and are similarly noisy. For anything quoted in
the report, run several seeds and give the spread.

**Traffic impact is the weakest result.** Mobility barely separates, and under heavy
congestion the rerouting configurations are occasionally worse. That is a real
finding, not an artefact: each vehicle reroutes greedily on peer reports, so a
widely announced jam can send them all onto the same alternative — the herding
effect congestion-responsive routing is known to produce in the field. Beating the
baseline here needs coordinated assignment, which is scoped as future work.

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

## Hosting it

There are two ways to run this, and they share the same UI.

### Static build — the simulation runs in your browser (recommended for demos)

`frontend/src/sim/` is a TypeScript port of the Python engine, so the entire
system — vehicles, gossip radio, edge inference, FedAvg, digital twin, security,
and the experiment harness — executes client-side. That makes the site a **pure
static bundle with no backend at all**: instant load, no cold starts, free to host
anywhere.

The congestion model is not reimplemented. `frontend/src/sim/model.json` holds the
exact gradient-boosted trees fitted by the Python pipeline, and the TypeScript walk
reproduces scikit-learn's prediction to within 5e-07, so the hosted demo is
numerically faithful to the results in the report. The two engines are checked
against each other on an unbiased mobility metric (see below): TypeScript 1.302
vs Python 1.292 segments per 100 vehicle-ticks across 8 seeds.

Deploy to Vercel by importing this repo — `vercel.json` sets the build command and
the SPA rewrite. Or from the repo root:

```bash
npx vercel --prod
```

Any static host works (Netlify, GitHub Pages, S3); just serve `frontend/dist` and
rewrite unknown paths to `index.html` for client-side routing.

If the host *cannot* rewrite — plain object storage, or a bundle served from a
sub-path — build in hash mode instead, which needs no server-side routing at all:

```bash
cd frontend && VITE_ROUTER=hash VITE_BASE=./ npm run build
```

That emits relative asset URLs and routes on `#/control`, `#/experiments` and so
on, so a deep link survives a reload anywhere.

### Python backend — the research artifact

The FastAPI engine under `backend/` remains the reference implementation and is
what the report's numbers come from. It is a **long-lived ticking loop with a
WebSocket attached**, so it needs a persistent process and will *not* run on
serverless functions. For that path the API process also serves the built
frontend, so it is one service on one port:

```bash
docker build -t v2x-ecosystem . && docker run -p 8000:8000 v2x-ecosystem
```

`render.yaml` deploys that container on Render's free tier.

## A note on measuring traffic impact

`avg_trip_ticks` only counts journeys that *finish inside the run*, which
over-samples short routes — a survivorship bias that makes the number depend on
the window length. It is still reported, labelled as biased, but the metric to
compare on is **segments per 100 vehicle-ticks**, where every vehicle contributes
every tick whether or not it reaches its destination. Likewise, corroborated
alerts are rare events, so the alert-latency figure carries its sample count and
the site refuses to headline it below five samples.

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
