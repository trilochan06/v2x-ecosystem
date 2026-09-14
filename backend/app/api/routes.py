from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import CONFIGS
from app.experiments.runner import (
    DEFAULT_REPEATS,
    MAX_REPEATS,
    list_configs,
    list_scenarios,
    run_suite,
)
from app.reference import LAYERS, MODULES, TEAM
from app.runtime import get_engine, rebuild_engine

router = APIRouter(prefix="/api")


class RsuToggleRequest(BaseModel):
    alive: bool


class CloudRequest(BaseModel):
    online: bool


class ArchitectureRequest(BaseModel):
    key: str


class DensityRequest(BaseModel):
    #: Bounded so a request cannot ask for a city that never finishes a tick.
    vehicles: int = Field(ge=1, le=200)


class ExperimentRequest(BaseModel):
    scenario: str = "normal"
    ticks: int = Field(default=250, ge=60, le=800)
    seed: int = 4242
    #: Seeds per configuration. Anything above 1 gets confidence intervals.
    repeats: int = Field(default=DEFAULT_REPEATS, ge=1, le=MAX_REPEATS)


# ------------------------------------------------------------------ status
@router.get("/health")
def health():
    return {"status": "ok", "tick": get_engine().tick}


@router.get("/state")
def get_state():
    return get_engine().state_snapshot()


@router.get("/reference")
def reference():
    """Layer and module definitions straight from the project design."""
    return {"layers": LAYERS, "modules": MODULES, "team": TEAM}


@router.get("/architecture/configs")
def architecture_configs():
    return {"configs": list_configs(), "active": get_engine().config.key}


@router.post("/architecture/switch")
def switch_architecture(req: ArchitectureRequest):
    if req.key not in CONFIGS:
        raise HTTPException(status_code=404, detail="unknown architecture configuration")
    engine = rebuild_engine(CONFIGS[req.key])
    return {"active": engine.config.key, "label": engine.config.label}


# ------------------------------------------------------------- live control
@router.post("/vehicles/spawn")
def spawn_vehicle():
    return {"vehicle_id": get_engine().spawn_vehicle("car").id}


@router.post("/emergency/spawn")
def spawn_ambulance():
    v = get_engine().spawn_vehicle("ambulance")
    return {"vehicle_id": v.id, "route": v.route}


@router.post("/malicious/spawn")
def spawn_malicious():
    return {"vehicle_id": get_engine().spawn_vehicle("malicious").id}


@router.post("/vehicles/density")
def set_density(request: DensityRequest):
    """Thin the traffic out or pack it in.

    A map is only readable at a density the viewer chose; twenty-six dots
    measures well and reads badly.
    """
    return {"vehicles": get_engine().set_vehicle_count(request.vehicles)}


@router.post("/pedestrians")
def spawn_pedestrian():
    """Step someone onto a crossing (the collective-perception use case)."""
    engine = get_engine()
    pedestrian_id = engine.spawn_pedestrian()
    if pedestrian_id is None:
        raise HTTPException(status_code=409, detail="no crossing available")
    return {
        "pedestrian_id": pedestrian_id,
        "segment_id": engine.pedestrians[pedestrian_id].segment_id,
    }


@router.post("/hazards")
def inject_hazard():
    segment_id = get_engine().inject_hazard()
    if segment_id is None:
        raise HTTPException(status_code=409, detail="no clear segment available")
    return {"segment_id": segment_id}


@router.post("/hazards/{segment_id}")
def inject_hazard_on(segment_id: str):
    engine = get_engine()
    if segment_id not in engine.grid.segments:
        raise HTTPException(status_code=404, detail="unknown segment")
    return {"segment_id": engine.inject_hazard(segment_id)}


@router.post("/faults/rsu/{rsu_id}/toggle")
def toggle_rsu(rsu_id: str, req: RsuToggleRequest):
    engine = get_engine()
    if rsu_id not in engine.rsus:
        raise HTTPException(status_code=404, detail="unknown RSU")
    engine.toggle_rsu(rsu_id, req.alive)
    return {"rsu_id": rsu_id, "alive": req.alive}


@router.post("/faults/cloud")
def toggle_cloud(req: CloudRequest):
    get_engine().set_cloud_online(req.online)
    return {"cloud_online": req.online}


@router.post("/attacks/replay")
def replay_attack():
    return get_engine().inject_replay_attack()


# ---------------------------------------------------------------- analytics
@router.get("/segments/{segment_id}/prediction")
def segment_prediction(segment_id: str):
    engine = get_engine()
    seg = engine.grid.segments.get(segment_id)
    if seg is None:
        raise HTTPException(status_code=404, detail="unknown segment")
    return engine.predictor.predict(seg, engine.tick)


@router.get("/federated")
def federated():
    return get_engine().federation.snapshot()


@router.get("/security")
def security():
    engine = get_engine()
    return {
        "pseudonyms": engine.authority.snapshot(len(engine.vehicles)),
        "replay": engine.replay_guard.snapshot(),
        "certificates": engine.cert_policy.snapshot(),
        "trust": engine.trust.snapshot(),
        "revoked": sorted(engine.authority.revoked),
    }


# -------------------------------------------------------------- experiments
@router.get("/experiments/scenarios")
def experiment_scenarios():
    return {"scenarios": list_scenarios(), "configs": list_configs()}


@router.post("/experiments/run")
def experiments_run(req: ExperimentRequest):
    return run_suite(
        scenario_key=req.scenario, ticks=req.ticks, seed=req.seed, repeats=req.repeats
    )
