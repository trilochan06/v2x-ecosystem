"""Lightweight simulated PKI + trust management.

A real deployment would use vehicle identity certificates issued by a road
authority CA and mutual TLS / IEEE 1609.2 signed messages. For this
simulation we emulate the same guarantees with per-vehicle HMAC keys
("certificates") and a corroboration-based trust score, so the security
properties claimed by the architecture (message authenticity, malicious
node detection, trust-weighted decisions) are demonstrable end-to-end
without pulling in a full X.509/blockchain stack.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import secrets
from dataclasses import dataclass, field


def issue_certificate() -> str:
    """Simulate a CA issuing a signing key bound to a vehicle identity."""
    return secrets.token_hex(16)


def sign(payload: dict, key: str) -> str:
    body = json.dumps(payload, sort_keys=True).encode()
    return hmac.new(key.encode(), body, hashlib.sha256).hexdigest()


def verify(payload: dict, signature: str, key: str) -> bool:
    return hmac.compare_digest(sign(payload, key), signature)


TRUST_INITIAL = 1.0
# Soft quarantine: this node's reports stop counting toward corroboration,
# but it stays on the air and can earn its way back.
TRUST_QUARANTINE_THRESHOLD = 0.35
# Hard revocation: the certificate is pulled and the node is off the
# network. Deliberately far below the quarantine line, because revoking an
# honest vehicle that merely had a run of unwitnessed reports is a much
# worse failure than tolerating a noisy one for a few more ticks.
TRUST_REVOCATION_THRESHOLD = 0.12
# Minimum evidence before revocation is even considered.
TRUST_REVOCATION_MIN_REPORTS = 10
# A node needs a minimum sample size before its score is allowed to move --
# this stops a single unlucky (unwitnessed) honest report from crashing an
# otherwise-good vehicle's trust straight to zero.
TRUST_MIN_SAMPLES = 4
# Score drifts toward the node's observed corroboration rate rather than
# random-walking, so one bad report can't dominate and one good report
# can't instantly launder a bad track record.
TRUST_EMA_ALPHA = 0.2


@dataclass
class TrustRegistry:
    """Tracks a running trust score per node based on whether its hazard
    reports are corroborated by independent neighbors within a time window.
    """

    scores: dict[str, float] = field(default_factory=dict)
    reports_seen: dict[str, int] = field(default_factory=dict)
    reports_corroborated: dict[str, int] = field(default_factory=dict)

    def register(self, node_id: str) -> None:
        self.scores.setdefault(node_id, TRUST_INITIAL)
        self.reports_seen.setdefault(node_id, 0)
        self.reports_corroborated.setdefault(node_id, 0)

    def score(self, node_id: str) -> float:
        return self.scores.get(node_id, TRUST_INITIAL)

    def is_trusted(self, node_id: str) -> bool:
        return self.score(node_id) >= TRUST_QUARANTINE_THRESHOLD

    def should_revoke(self, node_id: str) -> bool:
        """Only a sustained, well-evidenced pattern of uncorroborated
        reporting justifies pulling a certificate."""
        return (
            self.reports_seen.get(node_id, 0) >= TRUST_REVOCATION_MIN_REPORTS
            and self.score(node_id) < TRUST_REVOCATION_THRESHOLD
        )

    def record_report(self, node_id: str, corroborated: bool) -> None:
        self.register(node_id)
        self.reports_seen[node_id] += 1
        if corroborated:
            self.reports_corroborated[node_id] += 1

        seen = self.reports_seen[node_id]
        if seen < TRUST_MIN_SAMPLES:
            return

        rate = self.reports_corroborated[node_id] / seen
        current = self.scores[node_id]
        self.scores[node_id] = round(current + (rate - current) * TRUST_EMA_ALPHA, 4)

    def snapshot(self) -> dict[str, dict]:
        out = {}
        for node_id, score in self.scores.items():
            seen = self.reports_seen.get(node_id, 0)
            corroborated = self.reports_corroborated.get(node_id, 0)
            out[node_id] = {
                "trust_score": score,
                "reports_seen": seen,
                "reports_corroborated": corroborated,
                "quarantined": score < TRUST_QUARANTINE_THRESHOLD,
            }
        return out
