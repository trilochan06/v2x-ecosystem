"""Trust-weighted federated aggregation.

Plain FedAvg weights a client by how much data it has, which is the wrong
instinct when some of that data came from vehicles nobody believes: the
busiest compromised RSU gets the loudest vote. These tests pin the defence
and, more importantly, pin that it actually helps -- a defence that changes
nothing under attack is not a defence.
"""
import numpy as np
import pytest

from app.ai.federated import (
    TRUST_EXCLUSION_FLOOR,
    FederatedClient,
    FederatedCoordinator,
)


def feed(client: FederatedClient, n: int, slope: float = 0.5, trust: float = 1.0) -> None:
    for i in range(n):
        x = (i % 20) / 20
        client.observe([x] * 7, slope * x, source_trust=trust)


# ------------------------------------------------------------ data trust
def test_a_client_reports_the_trust_of_its_sources():
    client = FederatedClient("rsu-1")
    feed(client, 20, trust=0.4)
    assert client.data_trust == pytest.approx(0.4)


def test_mixed_sources_average_out():
    client = FederatedClient("rsu-1")
    feed(client, 10, trust=1.0)
    feed(client, 10, trust=0.0)
    assert client.data_trust == pytest.approx(0.5)


def test_a_fresh_client_is_trusted_until_shown_otherwise():
    assert FederatedClient("rsu-1").data_trust == 1.0


# ------------------------------------------------------------ weighting
def test_with_everyone_trusted_it_reduces_exactly_to_fedavg():
    """The defence must be free when there is nothing to defend against."""
    coordinator = FederatedCoordinator()
    a, b = FederatedClient("rsu-a"), FederatedClient("rsu-b")
    feed(a, 20, slope=0.2)
    feed(b, 60, slope=0.9)

    summary = coordinator.run_round([a, b], tick=1)

    assert summary is not None
    np.testing.assert_allclose(
        coordinator.global_weights.w, coordinator._plain_weights.w, rtol=1e-9
    )
    assert summary.excluded_clients == []


def test_a_distrusted_client_is_excluded_from_the_round():
    coordinator = FederatedCoordinator()
    honest = FederatedClient("rsu-honest")
    poisoned = FederatedClient("rsu-poisoned")
    feed(honest, 20, slope=0.2, trust=1.0)
    feed(poisoned, 200, slope=5.0, trust=0.1)  # far more data, far less trust

    summary = coordinator.run_round([honest, poisoned], tick=1)

    assert summary is not None
    assert summary.excluded_clients == ["rsu-poisoned"]
    # Plain FedAvg would have been dominated by the 200-sample client.
    assert not np.allclose(coordinator.global_weights.w, coordinator._plain_weights.w)


def test_the_excluded_client_is_not_given_the_global_model():
    """Exclusion means it takes no part: it neither shapes the global model
    nor receives it, and its local buffer is left alone.

    (It still trains locally -- that happens before aggregation and is how it
    would earn its way back once its sources are corroborated again.)"""
    coordinator = FederatedCoordinator()
    honest = FederatedClient("rsu-honest")
    poisoned = FederatedClient("rsu-poisoned")
    feed(honest, 20, trust=1.0)
    feed(poisoned, 20, slope=5.0, trust=0.1)

    coordinator.run_round([honest, poisoned], tick=1)

    assert not np.allclose(poisoned.weights.w, coordinator.global_weights.w)
    # load_global() clears the buffer; an excluded client keeps its data.
    assert poisoned.pending_samples > 0
    assert honest.pending_samples == 0


def test_partial_trust_scales_influence_without_excluding():
    """Between the floor and full trust, a client is quietened, not silenced."""
    above_floor = (TRUST_EXCLUSION_FLOOR + 1.0) / 2
    coordinator = FederatedCoordinator()
    a, b = FederatedClient("rsu-a"), FederatedClient("rsu-b")
    feed(a, 40, slope=0.2, trust=1.0)
    feed(b, 40, slope=0.9, trust=above_floor)

    summary = coordinator.run_round([a, b], tick=1)

    assert summary is not None
    assert summary.excluded_clients == []
    # b is still in, but pulled the mean less than an equal-sample peer would.
    assert not np.allclose(coordinator.global_weights.w, coordinator._plain_weights.w)


def test_a_fully_distrusted_network_falls_back_rather_than_stalling():
    """Everyone being distrusted at once is an anomaly, not a reason to stop
    learning -- and the round says so by excluding nobody."""
    coordinator = FederatedCoordinator()
    a, b = FederatedClient("rsu-a"), FederatedClient("rsu-b")
    feed(a, 20, trust=0.05)
    feed(b, 20, trust=0.05)

    summary = coordinator.run_round([a, b], tick=1)

    assert summary is not None
    assert summary.excluded_clients == []
    np.testing.assert_allclose(
        coordinator.global_weights.w, coordinator._plain_weights.w, rtol=1e-9
    )


# ----------------------------------------------------- does it actually help
def test_trust_weighting_beats_plain_fedavg_under_poisoning():
    """The claim the project makes, measured rather than asserted.

    A poisoned client with a wildly wrong slope and the largest sample count
    drags plain FedAvg away from the validation target. Trust weighting keeps
    the global model closer to it.
    """
    coordinator = FederatedCoordinator()
    honest_a, honest_b = FederatedClient("rsu-a"), FederatedClient("rsu-b")
    poisoned = FederatedClient("rsu-evil")
    feed(honest_a, 60, slope=0.45, trust=1.0)
    feed(honest_b, 60, slope=0.5, trust=1.0)
    feed(poisoned, 300, slope=-4.0, trust=0.05)

    summary = coordinator.run_round([honest_a, honest_b, poisoned], tick=1)

    assert summary is not None
    assert summary.global_loss < summary.plain_fedavg_loss


def test_the_round_reports_the_comparison_for_display():
    coordinator = FederatedCoordinator()
    client = FederatedClient("rsu-1")
    feed(client, 40, trust=0.8)

    summary = coordinator.run_round([client], tick=3)
    assert summary is not None
    payload = summary.as_dict()

    assert "plain_fedavg_loss" in payload
    assert payload["mean_client_trust"] == pytest.approx(0.8)
    assert payload["excluded_clients"] == []
