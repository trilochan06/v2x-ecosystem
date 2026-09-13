"""Process-wide live simulation + WebSocket fan-out.

The live engine is the one the control centre watches. It can be rebuilt
against a different `ArchitectureConfig` at runtime, which is how the site
lets you watch the centralized baseline and the proposed architecture
behave differently on the same map.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import WebSocket

from app.config import DEFAULT_CONFIG, ArchitectureConfig
from app.simulation.engine import SimulationEngine

logger = logging.getLogger("v2x")

TICK_INTERVAL_SECONDS = 0.8

_engine: SimulationEngine | None = None


def get_engine() -> SimulationEngine:
    global _engine
    if _engine is None:
        _engine = SimulationEngine(config=DEFAULT_CONFIG)
    return _engine


def is_ready() -> bool:
    """Ready means: the model has fitted, an engine exists, and the tick loop
    is running. Until all three hold, this instance would serve an empty
    simulation and should not be sent traffic."""
    return _engine is not None and _tick_task is not None and not _tick_task.done()


def rebuild_engine(config: ArchitectureConfig) -> SimulationEngine:
    """Swap the live architecture. The model is shared and already fitted,
    so this is fast enough to do from a button click."""
    global _engine
    _engine = SimulationEngine(config=config)
    return _engine


class ConnectionManager:
    def __init__(self):
        self.active: list[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        async with self._lock:
            self.active.append(ws)

    async def disconnect(self, ws: WebSocket) -> None:
        async with self._lock:
            if ws in self.active:
                self.active.remove(ws)

    async def broadcast_json(self, payload: dict) -> None:
        stale = []
        for ws in list(self.active):
            try:
                await ws.send_json(payload)
            except Exception:
                stale.append(ws)
        if stale:
            async with self._lock:
                for ws in stale:
                    if ws in self.active:
                        self.active.remove(ws)


manager = ConnectionManager()
_tick_task: asyncio.Task | None = None


async def _tick_loop() -> None:
    while True:
        try:
            engine = get_engine()
            engine.step()
            await manager.broadcast_json(engine.state_snapshot())
        except Exception:
            logger.exception("simulation tick failed")
        await asyncio.sleep(TICK_INTERVAL_SECONDS)


def start_tick_loop() -> None:
    global _tick_task
    if _tick_task is None:
        _tick_task = asyncio.create_task(_tick_loop())


def stop_tick_loop() -> None:
    global _tick_task
    if _tick_task is not None:
        _tick_task.cancel()
        _tick_task = None
