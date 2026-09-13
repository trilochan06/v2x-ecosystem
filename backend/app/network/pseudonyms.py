"""M11 - Security & Trust: pseudonymous identity, rotation, replay defence.

Slide 16 of the deck asks for three things, and they pull against each
other in a way worth being explicit about:

  1. pseudonymous identities that rotate often, so nobody can follow a
     vehicle across the city by watching the air;
  2. certificate-based authentication, so messages can't be spoofed;
  3. detection of misbehaving nodes -- which normally requires exactly the
     long-lived identity that (1) destroys.

Real C-V2X deployments resolve this with an SCMS: a vehicle broadcasts
under short-lived pseudonym certificates, RSUs can verify a pseudonym is
validly issued but cannot link two pseudonyms to the same car, and only a
separate misbehaviour authority can resolve a pseudonym back to its
long-term identity in order to revoke it.

That is the split modelled here. `PseudonymAuthority` privately holds the
pseudonym -> vehicle mapping; RSUs are given only the pseudonym and a
verification result. Misbehaviour evidence is reported *to* the authority,
which accumulates it against the durable identity, so rotating a pseudonym
does not launder a bad reputation -- while an observer on the road still
sees an identifier that changes every few seconds.
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

# How long one pseudonym certificate stays valid before rotation.
PSEUDONYM_LIFETIME_TICKS = 40
# A message older than this (or from the future) is stale -- the freshness
# check that defeats naive replay.
FRESHNESS_WINDOW_TICKS = 8


@dataclass
class PseudonymCertificate:
    pseudonym: str
    signing_key: str
    issued_tick: int
    expires_tick: int

    def is_valid(self, tick: int) -> bool:
        return self.issued_tick <= tick <= self.expires_tick


@dataclass
class PseudonymAuthority:
    """Issues short-lived certificates and is the only party that can link
    a pseudonym back to the vehicle behind it."""

    lifetime_ticks: int = PSEUDONYM_LIFETIME_TICKS
    _active: dict[str, PseudonymCertificate] = field(default_factory=dict)   # vehicle_id -> cert
    _linkage: dict[str, str] = field(default_factory=dict)                   # pseudonym -> vehicle_id
    _history: dict[str, list[str]] = field(default_factory=dict)             # vehicle_id -> pseudonyms
    revoked: set[str] = field(default_factory=set)                           # vehicle ids
    issued_count: int = 0
    rotation_count: int = 0

    def enroll(self, vehicle_id: str, tick: int) -> PseudonymCertificate:
        return self._issue(vehicle_id, tick, rotation=False)

    def _issue(self, vehicle_id: str, tick: int, rotation: bool) -> PseudonymCertificate:
        cert = PseudonymCertificate(
            pseudonym=f"pid-{secrets.token_hex(4)}",
            signing_key=secrets.token_hex(16),
            issued_tick=tick,
            expires_tick=tick + self.lifetime_ticks,
        )
        self._active[vehicle_id] = cert
        self._linkage[cert.pseudonym] = vehicle_id
        self._history.setdefault(vehicle_id, []).append(cert.pseudonym)
        self.issued_count += 1
        if rotation:
            self.rotation_count += 1
        return cert

    def certificate_for(self, vehicle_id: str, tick: int) -> PseudonymCertificate:
        cert = self._active.get(vehicle_id)
        if cert is None:
            return self._issue(vehicle_id, tick, rotation=False)
        if not cert.is_valid(tick):
            return self._issue(vehicle_id, tick, rotation=True)
        return cert

    def rotate_expired(self, vehicle_ids: list[str], tick: int) -> list[str]:
        """Rotate every certificate that has aged out. Returns the vehicles
        that received a fresh pseudonym this tick."""
        rotated = []
        for vehicle_id in vehicle_ids:
            cert = self._active.get(vehicle_id)
            if cert is None or not cert.is_valid(tick):
                self._issue(vehicle_id, tick, rotation=cert is not None)
                rotated.append(vehicle_id)
        return rotated

    # -- verification: what an RSU is allowed to learn ---------------------
    def verify(self, pseudonym: str, tick: int) -> bool:
        """An RSU can confirm a pseudonym was validly issued and is not
        revoked. It learns nothing about which vehicle it belongs to."""
        vehicle_id = self._linkage.get(pseudonym)
        if vehicle_id is None or vehicle_id in self.revoked:
            return False
        cert = self._active.get(vehicle_id)
        return cert is not None and cert.pseudonym == pseudonym and cert.is_valid(tick)

    def signing_key_for(self, pseudonym: str) -> str | None:
        vehicle_id = self._linkage.get(pseudonym)
        if vehicle_id is None:
            return None
        cert = self._active.get(vehicle_id)
        return cert.signing_key if cert and cert.pseudonym == pseudonym else None

    # -- privileged: only the misbehaviour authority may do this ----------
    def resolve(self, pseudonym: str) -> str | None:
        return self._linkage.get(pseudonym)

    def revoke(self, vehicle_id: str) -> None:
        self.revoked.add(vehicle_id)

    def pseudonyms_issued_to(self, vehicle_id: str) -> int:
        return len(self._history.get(vehicle_id, []))

    def snapshot(self, vehicle_count: int) -> dict:
        per_vehicle = [len(v) for v in self._history.values()] or [0]
        return {
            "certificates_issued": self.issued_count,
            "rotations": self.rotation_count,
            "lifetime_ticks": self.lifetime_ticks,
            "avg_pseudonyms_per_vehicle": round(sum(per_vehicle) / len(per_vehicle), 2),
            "revoked_vehicles": len(self.revoked),
            "tracked_vehicles": vehicle_count,
        }


@dataclass
class ReplayGuard:
    """Message integrity: freshness window + nonce memory.

    A replayed frame carries an old timestamp and a message id that has
    already been seen, so both checks catch it independently.

    The nonce memory is per *receiver*. A single broadcast legitimately
    arrives at many nodes, and each of them is seeing it for the first
    time; only a repeat arrival at the *same* node is a replay.
    """

    freshness_window: int = FRESHNESS_WINDOW_TICKS
    _seen: dict[tuple[str, str], int] = field(default_factory=dict)
    replays_blocked: int = 0
    stale_dropped: int = 0
    accepted: int = 0

    def accept(self, receiver_id: str, message_id: str, created_tick: int, now: int) -> bool:
        if now - created_tick > self.freshness_window or created_tick > now:
            self.stale_dropped += 1
            return False
        key = (receiver_id, message_id)
        if key in self._seen:
            self.replays_blocked += 1
            return False
        self._seen[key] = now + self.freshness_window * 4
        self.accepted += 1
        return True

    def prune(self, now: int) -> None:
        expired = [key for key, exp in self._seen.items() if exp <= now]
        for key in expired:
            del self._seen[key]

    def snapshot(self) -> dict:
        total = self.accepted + self.replays_blocked + self.stale_dropped
        return {
            "accepted": self.accepted,
            "replays_blocked": self.replays_blocked,
            "stale_dropped": self.stale_dropped,
            "rejection_rate_pct": round(
                100 * (self.replays_blocked + self.stale_dropped) / total if total else 0.0, 2
            ),
            "freshness_window_ticks": self.freshness_window,
        }
