"""Predictive emergency corridor formation.

When an ambulance (or any priority vehicle) enters the network, the manager
predicts its near-term path, preempts traffic lights ahead of it, and
issues explained yield instructions to vehicles occupying those segments --
so the lane clears *before* the ambulance arrives instead of after drivers
notice a siren.
"""
from __future__ import annotations

from dataclasses import dataclass, field

from app.network.messages import (
    PATH_POINT_BYTES,
    CauseCode,
    Message,
    MessageType,
)
from app.network.security import sign
from app.simulation.traffic_light import TrafficLight
from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid

LOOKAHEAD_NODES = 4
PREEMPT_HOLD_TICKS = 8


@dataclass
class EmergencyCorridorManager:
    grid: CityGrid
    active_corridors: dict[str, dict] = field(default_factory=dict)
    events: list[dict] = field(default_factory=list)
    #: Frames raised this tick, drained by the engine so they are transmitted
    #: and paid for like any other broadcast.
    pending_frames: list[Message] = field(default_factory=list)

    def activate(self, ambulance: Vehicle, tick: int) -> Message:
        self.active_corridors[ambulance.id] = {"activated_tick": tick}
        self.events.append({"tick": tick, "type": "corridor_activated", "ambulance_id": ambulance.id})
        route = ambulance.route[:LOOKAHEAD_NODES]
        payload = {
            "ambulance_id": ambulance.id,
            "cause_code": int(CauseCode.EMERGENCY_VEHICLE_APPROACHING),
            "sub_cause_code": 0,
            "route": route,
            "eta_seconds": self._eta_table(ambulance),
        }
        frame = Message(
            type=MessageType.DENM_EVA,
            sender_id=ambulance.id,
            pseudonym=ambulance.pseudonym,
            payload=payload,
            ttl=self.grid.size * 2,
            created_tick=tick,
            signature=sign(payload, ambulance.signing_key),
            # The predicted path and its ETA table are what make this frame
            # bigger than a plain hazard DENM.
            variable_bytes=len(route) * PATH_POINT_BYTES,
        )
        self.pending_frames.append(frame)
        return frame

    def drain_frames(self) -> list[Message]:
        """Hand the engine everything raised since the last drain."""
        frames, self.pending_frames = self.pending_frames, []
        return frames

    def _eta_table(self, ambulance: Vehicle) -> dict[str, float]:
        eta = {}
        cumulative_m = 0.0
        route = ambulance.route[:LOOKAHEAD_NODES]
        for i in range(len(route) - 1):
            seg = self.grid.segment_between(route[i], route[i + 1])
            cumulative_m += seg.length_m
            eta[route[i + 1]] = round(cumulative_m / (ambulance.speed_kmh * 1000 / 3600), 1)
        return eta

    def step(
        self,
        tick: int,
        ambulances: list[Vehicle],
        all_vehicles: list[Vehicle],
        traffic_lights: dict[str, TrafficLight],
    ) -> list[dict]:
        yield_instructions: list[dict] = []
        active_ambulance_ids = {a.id for a in ambulances}
        for stale_id in list(self.active_corridors):
            if stale_id not in active_ambulance_ids:
                del self.active_corridors[stale_id]

        corridor_segment_ids: set[str] = set()

        for ambulance in ambulances:
            if ambulance.id not in self.active_corridors:
                self.activate(ambulance, tick)

            route = ambulance.route[:LOOKAHEAD_NODES]
            eta_table = self._eta_table(ambulance)
            for i in range(len(route) - 1):
                a, b = route[i], route[i + 1]
                seg = self.grid.segment_between(a, b)
                corridor_segment_ids.add(seg.id)
                light = traffic_lights.get(b)
                eta = eta_table.get(b, 0.0)
                if light:
                    light.preempt(tick, PREEMPT_HOLD_TICKS, f"ambulance {ambulance.id} ETA {eta}s")

            for v in all_vehicles:
                if v.kind == "ambulance":
                    continue
                if v.current_segment_id in corridor_segment_ids:
                    eta = eta_table.get(v.next_node or "", 0.0)
                    instruction = {
                        "ambulance_id": ambulance.id,
                        "eta_seconds": eta,
                        "explanation": (
                            f"Ambulance {ambulance.id} approaching, ETA {eta}s -- yield lane and slow down."
                        ),
                    }
                    v.yield_instruction = instruction
                    yield_instructions.append({"vehicle_id": v.id, **instruction})

        for v in all_vehicles:
            if v.kind != "ambulance" and v.current_segment_id not in corridor_segment_ids:
                v.yield_instruction = None

        return yield_instructions
