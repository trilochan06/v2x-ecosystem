"""Process-wide simulation engine + WebSocket connection registry, shared by
the REST routes, the WebSocket handler, and the background tick loop.
"""
from __future__ import annotations

import asyncio
import logging

from fastapi import WebSocket

from app.simulation.engine import SimulationEngine

logger = logging.getLogger("v2x")

TICK_INTERVAL_SECONDS = 0.8

engine = SimulationEngine()


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
