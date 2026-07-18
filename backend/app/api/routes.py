from __future__ import annotations

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.runtime import engine

router = APIRouter(prefix="/api")


class RsuToggleRequest(BaseModel):
    alive: bool


@router.get("/health")
def health():
    return {"status": "ok", "tick": engine.tick}


@router.get("/state")
def get_state():
    return engine.state_snapshot()


@router.post("/faults/rsu/{rsu_id}/toggle")
def toggle_rsu(rsu_id: str, req: RsuToggleRequest):
    if rsu_id not in engine.rsus:
        raise HTTPException(status_code=404, detail="unknown RSU")
    engine.toggle_rsu(rsu_id, req.alive)
    return {"rsu_id": rsu_id, "alive": req.alive}


@router.post("/emergency/spawn")
def spawn_ambulance():
    v = engine.spawn_vehicle("ambulance")
    return {"vehicle_id": v.id, "route": v.route}


@router.post("/malicious/spawn")
def spawn_malicious():
    v = engine.spawn_vehicle("malicious")
    return {"vehicle_id": v.id}


@router.post("/vehicles/spawn")
def spawn_vehicle():
    v = engine.spawn_vehicle("car")
    return {"vehicle_id": v.id}


@router.post("/incidents/{segment_id}")
def mark_incident(segment_id: str):
    if segment_id not in engine.grid.segments:
        raise HTTPException(status_code=404, detail="unknown segment")
    engine.mark_incident(segment_id)
    return {"segment_id": segment_id, "incident": True}


@router.get("/segments/{segment_id}/prediction")
def segment_prediction(segment_id: str):
    seg = engine.grid.segments.get(segment_id)
    if seg is None:
        raise HTTPException(status_code=404, detail="unknown segment")
    return engine.predictor.predict(seg, engine.tick)
