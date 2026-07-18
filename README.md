# AI-Driven Decentralized V2X Ecosystem

A working prototype of a next-generation, decentralized Vehicle-to-Everything
(V2X) communication platform for a B.Tech capstone project. It demonstrates a
scalable architecture designed to overcome key limitations of today's
industrial V2X / connected-vehicle systems (cloud dependency, passive
vehicles, reactive-only traffic views) rather than claiming to already
replace them.

Every vehicle is simulated as a compute node that senses, gossips hazard
reports to nearby vehicles, and reacts locally. Roadside Units (RSUs) are
edge-AI nodes, not dumb repeaters: they corroborate reports, run a live
congestion forecaster, self-heal when a neighboring RSU fails, and forward
only compact digests to the cloud layer. An ambulance entering the network
triggers a predictive emergency corridor -- traffic lights preempt and
nearby vehicles get an explained yield instruction before it arrives.

See [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) for what is implemented
vs. simulated vs. left as a documented roadmap item, and
[`docs/ROADMAP.md`](docs/ROADMAP.md) for the path to a full deployment-grade
system.

## Project layout

```
backend/    Python simulation engine, edge-AI congestion model, decentralized
            messaging/trust layer, emergency corridor logic, FastAPI app
frontend/   React + Vite digital twin dashboard (live map, explainable AI
            panel, trust/security panel, control console, event feed)
docs/       Architecture writeup and future-work roadmap
```

## Running it

### Backend

```bash
cd backend
python3 -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8000
```

This starts the FastAPI server, which trains the congestion forecaster once
at startup (a few seconds) and then ticks the simulation continuously,
broadcasting live state over `ws://localhost:8000/ws/state`.

### Frontend

```bash
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The dev server proxies `/api` and `/ws` to the
backend on port 8000.

### Tests

```bash
cd backend
source .venv/bin/activate
pytest
```

## What you can do in the dashboard

- **Click any road segment** to see the edge-AI's congestion forecast and a
  plain-language, attribution-based explanation of what is driving it.
- **Dispatch an ambulance** to watch predictive emergency-corridor formation:
  traffic lights ahead of it preempt to green and nearby vehicles receive an
  explained yield instruction before the ambulance arrives.
- **Inject a malicious vehicle** to watch the trust/security layer detect
  and quarantine it: it fabricates hazard reports nobody else corroborates,
  and its trust score converges toward zero while honest vehicles stay
  trusted.
- **Kill an RSU** to watch self-healing: vehicles in its cell are
  reassigned to the nearest surviving RSU within one tick, and gossip
  keeps propagating hazard reports vehicle-to-vehicle regardless.
