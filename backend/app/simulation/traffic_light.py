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

    @property
    def offset(self) -> int:
        """Phase offset for this junction, from its coordinates.

        Without it every light in the city turned red at the same instant,
        which is both unrealistic and useless to demonstrate against: a
        vehicle could never meet a red one junction and a green the next.
        Offsetting by position is also roughly what a real grid does to
        create a green wave.
        """
        try:
            x, y = (int(part) for part in self.node.split("-"))
        except ValueError:
            return 0
        return ((x + y) * (CYCLE_TICKS // 2)) % (CYCLE_TICKS * 2)

    def step(self, tick: int) -> None:
        if tick <= self.preempted_until:
            self.phase = "green"
            return
        self.preempt_reason = ""
        self.phase = "green" if ((tick + self.offset) // CYCLE_TICKS) % 2 == 0 else "red"

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
