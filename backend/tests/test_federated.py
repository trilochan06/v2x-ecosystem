"""Federation has to be real: parameters move, samples do not, and the
aggregation rule has to behave the way it claims under a dishonest client."""
from __future__ import annotations

import random

from app.ai.features import FEATURE_NAMES
from app.ai.federated import (
    MIN_SAMPLES_PER_ROUND,
    PARTICIPATION_TRUST_FLOOR,
    FederatedClient,
    FederatedCoordinator,
    Weights,
)
from app.simulation.engine import SimulationEngine

DIM = len(FEATURE_NAMES)


def _sample(seed: int) -> tuple[list[float], float]:
    rng = random.Random(seed)
    x = [rng.random() for _ in range(DIM)]
    # a simple, learnable target so convergence is checkable
    y = max(0.0, min(1.0, 0.5 * x[0] + 0.3 * x[6] + 0.1))
    return x, y


def test_client_will_not_train_below_the_minimum_sample_count():
    client = FederatedClient(rsu_id="rsu-1")
    for i in range(MIN_SAMPLES_PER_ROUND - 1):
        client.observe(*_sample(i))
    assert client.local_train() is None

    client.observe(*_sample(99))
    assert client.local_train() is not None


def test_adopting_the_aggregate_clears_the_local_buffer():
    """Samples stay on the unit and are dropped once used -- they are never
    carried anywhere, which is the whole point of federating."""
    client = FederatedClient(rsu_id="rsu-1")
    for i in range(20):
        client.observe(*_sample(i))
    client.local_train()
    assert client.buffer

    client.adopt(Weights())
    assert client.buffer == []


def test_rounds_reduce_holdout_loss():
    coord = FederatedCoordinator()
    for i in range(120):
        x, y = _sample(i)
        coord.client(f"rsu-{i % 4}").observe(x, y)
    for i in range(400, 460):
        coord.add_holdout(*_sample(i))

    first = None
    for r in range(8):
        summary = coord.run_round(tick=15 * (r + 1))
        assert summary is not None
        if first is None:
            first = summary.global_loss
        for i in range(120):
            x, y = _sample(i + r * 500)
            coord.client(f"rsu-{i % 4}").observe(x, y)

    assert coord.last_loss < first


def test_client_below_the_trust_floor_is_excluded():
    coord = FederatedCoordinator()
    for i in range(30):
        x, y = _sample(i)
        coord.client("honest").observe(x, y, source_trust=0.95)
        coord.client("suspect").observe(x, y, source_trust=0.1)
    coord.add_holdout(*_sample(900))

    summary = coord.run_round(tick=15)
    assert summary is not None
    assert "suspect" in summary.excluded
    assert "honest" in summary.participants
    assert coord.clients["suspect"].data_trust < PARTICIPATION_TRUST_FLOOR


def test_all_clients_below_the_floor_falls_back_rather_than_halting():
    """A network-wide collapse in trust is a reason to investigate, not a
    reason to stop learning or to emit an empty model."""
    coord = FederatedCoordinator()
    for i in range(30):
        x, y = _sample(i)
        coord.client("a").observe(x, y, source_trust=0.05)
        coord.client("b").observe(x, y, source_trust=0.05)
    coord.add_holdout(*_sample(901))

    summary = coord.run_round(tick=15)
    assert summary is not None
    assert summary.excluded == []
    assert set(summary.participants) == {"a", "b"}
    assert any(w != 0.0 for w in coord.global_weights.w)


def test_shadow_model_is_aggregated_from_the_same_uploads():
    """The comparison has to be between two rules on identical inputs, not
    between two separate runs."""
    coord = FederatedCoordinator()
    for i in range(30):
        x, y = _sample(i)
        coord.client("a").observe(x, y, source_trust=0.9)
        coord.client("b").observe(x, y, source_trust=0.55)
    coord.add_holdout(*_sample(902))

    summary = coord.run_round(tick=15)
    assert summary is not None
    assert summary.plain_loss != 0.0 or summary.global_loss != 0.0
    # differing trusts must make the two aggregates actually differ
    assert coord.global_weights.w != coord.shadow_weights.w


def test_weights_on_the_wire_are_far_smaller_than_the_samples():
    coord = FederatedCoordinator()
    for i in range(60):
        x, y = _sample(i)
        coord.client(f"rsu-{i % 3}").observe(x, y)
    coord.add_holdout(*_sample(903))

    summary = coord.run_round(tick=15)
    assert summary is not None
    assert summary.raw_bytes_avoided > summary.weights_bytes * 5


def test_engine_runs_federated_rounds_end_to_end():
    random.seed(9)
    engine = SimulationEngine()
    for _ in range(200):
        engine.step()

    state = engine.state_snapshot()["federated"]
    assert state["rounds_completed"] > 0
    assert len(state["clients"]) == len(engine.rsus)
    assert state["holdout_size"] > 0
    assert state["total_raw_bytes_avoided"] > state["total_weights_bytes"]
