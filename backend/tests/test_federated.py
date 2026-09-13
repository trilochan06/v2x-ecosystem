import numpy as np

from app.ai.federated import (
    MIN_SAMPLES_PER_ROUND,
    FederatedClient,
    FederatedCoordinator,
    ModelWeights,
)


def feed(client: FederatedClient, n: int, slope: float = 0.5) -> None:
    rng = np.random.default_rng(0)
    for _ in range(n):
        x = rng.random(7)
        client.observe(list(x), float(np.clip(slope * x[0] + 0.2, 0, 1)))


def test_client_withholds_until_it_has_enough_samples():
    client = FederatedClient("rsu-1")
    feed(client, MIN_SAMPLES_PER_ROUND - 1)
    assert client.local_train() is None


def test_local_training_returns_weights_and_sample_count():
    client = FederatedClient("rsu-1")
    feed(client, 40)
    trained = client.local_train()

    assert trained is not None
    weights, n, trust = trained
    assert n == 40
    assert isinstance(weights, ModelWeights)
    assert weights.w.shape == (7,)
    assert trust == 1.0  # nothing suspect has been observed


def test_fedavg_is_the_sample_weighted_mean():
    """The whole privacy claim rests on the aggregator only ever seeing
    weights, so the aggregation itself must be exactly the documented
    average -- verifiable by hand.

    With every client fully trusted, trust weighting reduces exactly to
    FedAvg, which is what this pins."""
    coordinator = FederatedCoordinator()

    a, b = FederatedClient("rsu-a"), FederatedClient("rsu-b")
    feed(a, 20, slope=0.2)
    feed(b, 60, slope=0.9)

    wa, na, _ = a.local_train()
    wb, nb, _ = b.local_train()
    expected = (wa.w * na + wb.w * nb) / (na + nb)

    # Re-run the same training through the coordinator.
    a2, b2 = FederatedClient("rsu-a"), FederatedClient("rsu-b")
    feed(a2, 20, slope=0.2)
    feed(b2, 60, slope=0.9)
    summary = coordinator.run_round([a2, b2], tick=10)

    assert summary is not None
    assert summary.samples_used == na + nb
    np.testing.assert_allclose(coordinator.global_weights.w, expected, rtol=1e-9)


def test_round_reports_bandwidth_saving():
    coordinator = FederatedCoordinator()
    client = FederatedClient("rsu-1")
    feed(client, 80)

    summary = coordinator.run_round([client], tick=5)

    assert summary is not None
    # Uploading weights must cost dramatically less than shipping the raw
    # observations they were learned from -- that is the point of M7.
    assert summary.raw_kilobytes_avoided > summary.weights_kilobytes * 10


def test_clients_adopt_the_global_model_and_clear_local_data():
    coordinator = FederatedCoordinator()
    client = FederatedClient("rsu-1")
    feed(client, 30)

    coordinator.run_round([client], tick=5)

    assert client.pending_samples == 0  # local buffer cleared after the round
    np.testing.assert_allclose(client.weights.w, coordinator.global_weights.w)


def test_round_with_no_eligible_clients_is_a_noop():
    coordinator = FederatedCoordinator()
    starved = FederatedClient("rsu-1")
    feed(starved, 2)

    assert coordinator.run_round([starved], tick=5) is None
    assert coordinator.rounds == []


def test_training_reduces_validation_loss():
    coordinator = FederatedCoordinator()
    start = coordinator.initial_loss

    for tick in range(12):
        client = FederatedClient("rsu-1")
        client.weights = coordinator.global_weights.copy()
        rng = np.random.default_rng(tick)
        for _ in range(60):
            x = rng.random(7)
            client.observe(list(x), float(np.clip(0.4 * x[0] + 0.3 * x[6] + 0.1, 0, 1)))
        coordinator.run_round([client], tick=tick)

    assert coordinator._last_loss < start
