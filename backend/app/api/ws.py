from __future__ import annotations

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.runtime import get_engine, manager

router = APIRouter()


@router.websocket("/ws/state")
async def ws_state(websocket: WebSocket):
    await manager.connect(websocket)
    try:
        await websocket.send_json(get_engine().state_snapshot())
        while True:
            # Client doesn't need to send anything; keep the connection
            # alive and tolerate any pings/messages it does send.
            await websocket.receive_text()
    except WebSocketDisconnect:
        await manager.disconnect(websocket)
