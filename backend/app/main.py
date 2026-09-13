from __future__ import annotations

import os
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, Response
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app.api.routes import router as api_router
from app.api.ws import router as ws_router
from app.observability import (
    PROMETHEUS_CONTENT_TYPE,
    configure_logging,
    install_request_id_middleware,
    render_prometheus,
)
from app.runtime import get_engine, is_ready, manager, start_tick_loop, stop_tick_loop


@asynccontextmanager
async def lifespan(_app: FastAPI):
    configure_logging()
    start_tick_loop()
    yield
    stop_tick_loop()


app = FastAPI(title="Intelligent Decentralized V2X Ecosystem", lifespan=lifespan)

# In development the Vite dev server runs on :5173 and proxies to us, so it
# is a cross-origin caller. In production we serve the built frontend
# ourselves and everything is same-origin.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

install_request_id_middleware(app)

app.include_router(api_router)
app.include_router(ws_router)


# --------------------------------------------------------------------------
# Operational endpoints. Registered before the SPA catch-all below, which
# would otherwise swallow them.
# --------------------------------------------------------------------------
@app.get("/health", tags=["ops"])
def health() -> dict:
    """Liveness. True whenever the process can answer at all."""
    return {"status": "ok"}


@app.get("/ready", tags=["ops"])
def ready() -> Response:
    """Readiness. 503 until the model has fitted and the loop is ticking."""
    if not is_ready():
        return JSONResponse({"status": "starting"}, status_code=503)
    return JSONResponse({"status": "ready", "tick": get_engine().tick})


@app.get("/metrics", tags=["ops"])
def metrics() -> Response:
    """Prometheus text exposition of the live simulation's counters."""
    body = render_prometheus(get_engine().state_snapshot(), websocket_clients=len(manager.active))
    return Response(content=body, media_type=PROMETHEUS_CONTENT_TYPE)


# --------------------------------------------------------------------------
# Serve the built frontend from the same process.
#
# The simulation is a long-lived ticking loop with a WebSocket attached, so it
# needs a persistent process anyway -- it cannot run on serverless. Given that,
# serving the static bundle from the same app keeps deployment to a single
# service on a single port, and makes the frontend same-origin so the relative
# /api and /ws URLs work with no build-time configuration.
#
# If the bundle has not been built, the API still runs; only the UI is absent.
# --------------------------------------------------------------------------
FRONTEND_DIST = Path(
    os.environ.get("V2X_FRONTEND_DIST", Path(__file__).resolve().parents[2] / "frontend" / "dist")
)


def _mount_frontend() -> None:
    if not (FRONTEND_DIST / "index.html").exists():
        return

    assets = FRONTEND_DIST / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    index_file = FRONTEND_DIST / "index.html"

    @app.get("/", include_in_schema=False)
    async def serve_index():
        return FileResponse(index_file)

    @app.get("/{full_path:path}", include_in_schema=False)
    async def serve_spa(full_path: str):
        """Client-side routes (/control, /experiments, ...) are not files, so
        anything that isn't a real asset falls back to index.html and lets
        React Router resolve it. Registered last, so it never shadows /api
        or /ws."""
        candidate = (FRONTEND_DIST / full_path).resolve()
        if candidate.is_file() and FRONTEND_DIST.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(index_file)


_mount_frontend()
