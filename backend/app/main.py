from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api.routes import router as api_router
from app.api.ws import router as ws_router
from app.runtime import start_tick_loop, stop_tick_loop


@asynccontextmanager
async def lifespan(app: FastAPI):
    start_tick_loop()
    yield
    stop_tick_loop()


app = FastAPI(title="V2X Decentralized Ecosystem", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(api_router)
app.include_router(ws_router)
