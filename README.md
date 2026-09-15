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

The website is the product: a guided demo that tells the system's stories one at
a time, a live control centre over the running simulation, a federated-learning
monitor, a security console, and an experiment harness that runs the three
architectures from the project design head-to-head and reports the measured
differences.

### Start here: the guided demo

`/demo` is the page to open first, and the one to show someone who has never
heard of V2X. Pick one of seven stories — a crash and the response it triggers,
a pedestrian seen around a corner, arriving on green, a liar being found out, a
cloud outage, the roadside units learning together, or all of it at once — and
it stages that event in the live simulation.

Down the side is a numbered checklist of what the story claims will happen. Each
line ticks off, with the tick it happened on, **only when the running simulation
actually does it**. Nothing is animated or scripted: a step that the system does
not produce stays dark. Steps that genuinely do not fire every run — priority at
a junction depends on where the signals fall along the route, and the ask can be
lost on the air — are labelled as such, so a dark line reads as an honest lossy
radio rather than a broken demo.

The clock stops when a story reaches its end, because these cascades are fast: a
collision is corroborated, alerted on and responded to within about three ticks,
which is the point being made and also far too quick to read if the scene keeps
moving.

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

Normal traffic, 400 ticks, **5 seeds per configuration** (4242–4246), with a
scripted cloud outage in every run. Every figure is a mean with a 95% confidence
interval (Student's t, not 1.96σ — at n = 5 the normal approximation is
optimistic). "Separated" means the two intervals do not overlap.

| Metric | Exp 1 — Centralized | Exp 3 — Proposed | Separated? |
| --- | --- | --- | --- |
| Cloud uplink overhead (KB/tick) | 2.843 ± 0.089 | **0.323 ± 0.000** | **yes — −88.6%** |
| Availability during cloud outage | 0.0 ± 0.0 % | **100.0 ± 0.0 %** | **yes — +100 pts** |
| Hazard detection precision | 0.885 ± 0.038 | **0.988 ± 0.019** | **yes — +0.10** |
| Hazard detection F1 | 0.424 ± 0.212 | 0.564 ± 0.181 | no — intervals overlap |
| Hazard-to-warning latency (ticks) | 19.8 ± 7.2 | 14.7 ± 6.0 | no — intervals overlap |
| Mobility (segments / 100 vehicle-ticks) | 1.233 ± 0.044 | 1.273 ± 0.044 | no — intervals overlap |
| Federated rounds completed | 0 | 24 | — |
| Raw telemetry avoided by FL | — | 275.6 KB | — |

**Three results hold up and three do not, and the difference matters.**

Uplink overhead, availability during outage, and detection precision separate
cleanly and are the project's actual findings. Uplink overhead is the strongest:
the centralized baseline streams a probe record per vehicle per tick whether or
not anything is happening, while the decentralized configuration sends only RSU
digests, twin sync and federated weights.

F1, alert latency and mobility do **not** separate at five seeds. Earlier
single-seed runs of this project reported a 46% latency improvement; across five
seeds that shrinks to 25.6% with intervals that overlap almost entirely, because
corroborated alerts are rare events — about seven per run — and the mean moves a
long way between seeds. The honest statement is that this simulation does not
demonstrate a latency improvement at this sample size. The site says so too: the
Experiments page prints "intervals overlap — not separated at this sample size"
rather than quoting the difference.

**Traffic impact remains the weakest result.** Mobility differs by 3% with
intervals that overlap, and under heavy congestion the rerouting configurations
are occasionally worse. That is a real finding, not an artefact: each vehicle
reroutes greedily on peer reports, so a widely announced jam can send them all
onto the same alternative — the herding effect congestion-responsive routing is
known to produce in the field.

### Exp 4: coordinated rerouting, tested and rejected

The obvious fix is coordination, so it was built and measured rather than
assumed. **Exp 4** is Exp 3 with one flag changed: vehicles announce where they
intend to go (an MCM, ETSI TR 103 578) and price a road by how many peers have
already claimed it, plus a per-vehicle tie-break so identical vehicles stop
computing identical detours.

First, the herding is real and the mechanism does fix it. Six vehicles at the
same junction heading for the same destination produce **one** detour under the
plain search and **six distinct** detours with the tie-break. The diagnosis was
also wrong in an instructive way: every road here is 250 m, so the search is
really minimising hop count, and the herding came from *ties being broken
identically in every vehicle* — determinism, not bad pricing.

Fixing it did not help. Over 10 seeds at 260 ticks:

| Metric | Exp 3 | Exp 4 | Separated? |
| --- | --- | --- | --- |
| Trips completed — normal | 24.0 ± 3.8 | 22.7 ± 4.1 | no |
| Trips completed — congestion | 36.2 ± 8.1 | 32.6 ± 9.2 | no |
| Avg trip time — congestion (ticks) | 102.7 ± 16.0 | 91.9 ± 11.1 | no |
| **Local radio load — normal (KB/tick)** | **1.89 ± 0.07** | **3.18 ± 0.06** | **yes — +68%** |
| **Local radio load — congestion (KB/tick)** | **3.06 ± 0.09** | **5.23 ± 0.08** | **yes — +71%** |

**The only thing that separates is the cost.** And the point estimate gets worse
as the network fills up — trips completed move from +1.2% at 10 vehicles to
−7.6% at 45, monotonically:

| Vehicles | Mean occupancy | Trips vs Exp 3 | Better on |
| --- | --- | --- | --- |
| 10 | 0.27 | +1.2% | 3/8 seeds |
| 18 | 0.40 | −1.3% | 2/8 seeds |
| 30 | 0.54 | −3.1% | 3/8 seeds |
| 45 | 0.65 | −7.6% | 0/8 seeds |

That gradient is the actual finding, and it has a mechanism. Spreading traffic
only pays if the alternatives are better. In a saturated uniform grid they are
not — every detour is longer and the roads it leads to are congested too — so
de-correlating routes adds vehicle-kilometres without relieving anything. The
apparent improvement in average trip time is survivorship: fewer trips finish,
so the ones that do are the short ones.

Exp 4 therefore ships **disabled** and exists only as the experiment that
measured it. Concluding "coordination helps" from the mobility metric alone
would have been easy — `segments_per_100_vehicle_ticks` rose 4.1% on 8/8 seeds —
and wrong, because that metric rewards driving further rather than arriving.

## Standards

The message set is not invented. Frames are the ETSI C-ITS "Day-1" services, and
the byte sizes are what drives the bandwidth results, so they are modelled on the
encodings rather than on `len(str(payload))`:

| Frame | Standard | Role | Size on the air |
| --- | --- | --- | --- |
| **CAM** | ETSI EN 302 637-2 | Periodic awareness heartbeat | 210 B signed (319 B when the certificate is attached) |
| **DENM** | ETSI EN 302 637-3 | Event-driven hazard warning | 273 B signed (382 B with certificate) |
| **DENM (EEBL)** | ETSI EN 302 637-3 | Emergency electronic brake light, cause 99/1 | 273 B signed |
| **CPM** | ETSI TS 103 324 | Collective perception | 214 B signed, +35 B per perceived object |
| **SPATEM** | ETSI TS 103 301 | Signal phase and timing | 100 B from the roadside unit |
| **SREM / SSEM** | ETSI TS 103 301 | Priority request and its answer | 177 B signed / 68 B |
| probe | — | Raw telemetry, the cloud-only baseline | 92 B over TLS |

A DENM carries a `causeCode`/`subCauseCode` from the **TS 102 894-2** Common Data
Dictionary rather than a free-text label — `oil_spill` encodes as cause 6
(adverseWeatherCondition-Adhesion), subcause 2 (fuelOnTheRoad). Where the
dictionary has no matching subcause, the value degrades to 0, which the standard
defines as "unavailable"; that is the correct encoding, not a placeholder.

Two details are modelled because they change the numbers:

- **Certificate attachment (IEEE 1609.2 / ETSI TS 103 097).** Putting a full
  certificate on every frame would be ruinous at 10 Hz, so a station attaches one
  about once a second and otherwise sends an 8-byte HashedId8 digest.
- **Privacy is not free.** Receivers cache a certificate against the pseudonym
  that sent it, so every pseudonym rotation forces a full re-attach. Rotating
  faster buys unlinkability and spends bandwidth — the Security page shows the
  running total.

Not implemented: MAPEM and IVIM. Intersection geometry is a grid here, so a MAPEM
would describe nothing a viewer cannot already see.

### Three connected-driving applications

Each is a standard frame doing something a driver would notice, and each is
reachable from the **Guided demo** and **Street view** pages in one click:

- **Emergency brake warning.** A car brakes hard for someone stepping out and
  emits a DENM with `causeCode` 99 / `subCauseCode` 1
  (*emergencyElectronicBrakeEngaged*). The traffic behind is told before any
  driver could see the brake lights. An attacker cannot emit one — the frame is
  believed on receipt, so a liar must not be able to raise it.
- **Collective perception.** Line of sight is limited to the crossing itself: a
  car turning in from a perpendicular street is blind, and the corner is why.
  A car that *can* see the pedestrian publishes a CPM, and the turning car slows
  for someone it has never seen. The frame grows 35 B per perceived object, so
  this is a bandwidth trade rather than a free win — the CPM column on the
  control centre shows what it costs.
- **Green Light Optimal Speed Advisory.** Junctions already broadcast SPaT; a
  vehicle hearing "red" on the junction it is approaching holds an advisory speed
  and arrives on green instead of braking and accelerating away. The advice is
  never faster than carrying on, and a phase heard about too long ago is
  discarded rather than acted on.

## Hosting it publicly

The simulation runs entirely in the browser, so the whole product is a static
bundle with no server to deploy. `.github/workflows/pages.yml` builds it and
publishes to GitHub Pages on every push to `main`.

**One-time setup:** in the repository, go to **Settings → Pages** and set
**Source** to **GitHub Actions**. The next push publishes to
`https://<user>.github.io/v2x-ecosystem/` — a public URL that needs no login.
The workflow can also be started by hand from the **Actions** tab
(*Pages → Run workflow*) without waiting for a commit.

Two build settings in that workflow are load-bearing, and both are about the
site living at a sub-path rather than a domain root:

- `VITE_BASE=/v2x-ecosystem/` so asset URLs carry the repository prefix.
- `VITE_ROUTER=hash` because Pages serves static files with no rewrite rules.
  Without it a deep link like `/demo` returns 404 on reload; with it,
  `/#/demo` survives a fresh load, a refresh, and being pasted to someone
  else.

The workflow typechecks and runs the test suite before it builds, so a broken
engine does not get published.

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

### Quality gates

CI runs all of these on every push (`.github/workflows/ci.yml`), and they are the
same commands locally:

```bash
# Backend: lint, types, tests with a coverage floor
cd backend && source .venv/bin/activate
pip install -r requirements-dev.txt
ruff check . && mypy && pytest --cov

# Frontend: lint, types, tests, production build
cd ../frontend
npm run lint && npm run typecheck && npm test && npm run build
```

268 tests — 195 Python, 73 TypeScript — at 93% backend coverage. The frame-size
constants are pinned to identical values on both sides, so if either engine
drifts, one of the two suites fails.

### The end-to-end pass

Those suites cover the two engines. They cannot catch a page that renders a
grid of zeros, a control wired to nothing, or a layout that pushes the
viewport sideways at 360 px — all of which had happened. `frontend/e2e.mjs`
drives a real browser over a production build and checks every feature a
visitor can touch: 64 assertions across routing, the guided demo's stories and
keyboard control, every scenario control on the street view and control
centre, the federated and security pages being alive on arrival, the
experiment sweep with its permalink and exports, and horizontal overflow at
five widths.

```bash
cd frontend
npm run build
npx vite preview --port 4200 --strictPort &   # or any static server with SPA rewrites
npm run e2e                                   # exits non-zero on any failure
```

It is not in CI: it needs a browser download that would slow the deploy
workflow and add a flake surface to something whose job is to publish. Run it
before a release.

### Operating it

The API process exposes the endpoints an orchestrator expects:

| Endpoint | Purpose |
| --- | --- |
| `GET /health` | Liveness. Cheap, true whenever the process answers. |
| `GET /ready` | Readiness. 503 until the model has fitted and the tick loop runs. |
| `GET /metrics` | Prometheus text exposition of the live simulation's counters. |

Logs are JSON lines carrying a request id, which is echoed back in the
`X-Request-ID` response header.

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

## How the measurements avoid fooling themselves

Three specific traps, and what is done about each.

**Survivorship bias in trip times.** `avg_trip_ticks` only counts journeys that
*finish inside the run*, which over-samples short routes and makes the number
depend on the window length. It is still reported, labelled as biased, but the
metric to compare on is **segments per 100 vehicle-ticks**, where every vehicle
contributes every tick whether or not it reaches its destination.

**One seed is not a result.** Every figure is a mean over several seeds with a
95% interval, and every configuration sees the *same* seeds so a difference
cannot come from one having drawn an easier run. Where intervals overlap, the
site says they overlap instead of quoting the gap between the means.

**Rare events masquerading as measurements.** Corroborated alerts happen a few
times per run, so the alert-latency mean carries its sample count and the site
refuses to headline it below five samples.

Detection quality is scored against the *physical* hazard state, never against
what the network believes, so a configuration that confidently confirms a
fabricated hazard is correctly penalised for it.

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
    network/      ETSI C-ITS messages, gossip radio, corroboration, trust, pseudonyms
    ai/           feature engineering, synthetic corpus, centralized model, federated learning
    decisions/    relevance filtering and alert dispatch
    emergency/    predictive emergency corridors
    experiments/  the Exp1/Exp2/Exp3 harness
    api/          REST + WebSocket
    stats.py      confidence intervals for the harness
    observability.py  health, readiness, Prometheus metrics, JSON logs
  tests/          101 tests
  pyproject.toml  ruff, mypy, pytest and coverage configuration
frontend/
  src/pages/      the six pages
  src/components/ map, panels, charts, error boundary
  src/sim/        the TypeScript port of the engine — what the hosted site runs
  src/sim/sim.test.ts  26 tests, incl. frame sizes pinned to the Python side
docs/
  ARCHITECTURE.md  design decisions and honest trade-offs
  EXPERIMENTS.md   methodology, metric definitions, how to reproduce
  ROADMAP.md       what a real deployment would still need
.github/workflows/ci.yml   lint, types, tests and builds for both halves
CONTRIBUTING.md   the gates, and the two-engine rule
SECURITY.md       what the modelled security is and is not
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
