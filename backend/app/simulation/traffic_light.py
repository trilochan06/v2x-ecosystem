"""Traffic light co-located with an RSU intersection. Normally cycles on a
fixed timer; can be preempted by the emergency corridor manager to force a
green phase ahead of an approaching ambulance.
"""
from __future__ import annotations

from dataclasses import dataclass

CYCLE_TICKS = 12


@dataclass
class TrafficLight:
    id: str
    node: str
    phase: str = "green"  # "green" | "red"
    preempted_until: int = -1
    preempt_reason: str = ""

    def step(self, tick: int) -> None:
        if tick <= self.preempted_until:
            self.phase = "green"
            return
        self.preempt_reason = ""
        self.phase = "green" if (tick // CYCLE_TICKS) % 2 == 0 else "red"

    def preempt(self, tick: int, hold_ticks: int, reason: str) -> None:
        self.preempted_until = max(self.preempted_until, tick + hold_ticks)
        self.preempt_reason = reason

    def to_state(self) -> dict:
        return {
            "id": self.id,
            "node": self.node,
            "phase": self.phase,
            "preempted": self.preempt_reason != "",
            "preempt_reason": self.preempt_reason,
        }
