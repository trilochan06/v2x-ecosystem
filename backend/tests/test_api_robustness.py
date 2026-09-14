"""The API under input a careless caller would actually send.

Unknown ids, malformed bodies and out-of-range parameters must produce a 404
or a 422, never a 500 and never a silently wrong answer. These are the
requests a demo gets when someone pokes the URL bar, and the ones a marker
will try.
"""
import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


# --------------------------------------------------------- unknown things
@pytest.mark.parametrize(
    "method,path,body",
    [
        ("post", "/api/faults/rsu/does-not-exist/toggle", {"alive": False}),
        ("get", "/api/segments/not-a-segment/prediction", None),
        ("post", "/api/hazards/not-a-segment", None),
        ("post", "/api/architecture/switch", {"key": "no-such-architecture"}),
    ],
)
def test_unknown_identifiers_are_refused_not_crashed(method, path, body):
    response = getattr(client, method)(path, json=body) if body else getattr(client, method)(path)
    assert response.status_code == 404, response.text


# -------------------------------------------------------- malformed input
@pytest.mark.parametrize(
    "path,body",
    [
        ("/api/faults/rsu/rsu-1/toggle", {"alive": "yes please"}),
        ("/api/faults/cloud", {}),
        ("/api/architecture/switch", {}),
    ],
)
def test_malformed_bodies_are_rejected_by_validation(path, body):
    assert client.post(path, json=body).status_code == 422


# ------------------------------------------------- out-of-range parameters
@pytest.mark.parametrize(
    "body",
    [
        {"ticks": 5},  # below the floor
        {"ticks": 99999},  # above the ceiling
        {"repeats": 0},
        {"repeats": 999},
    ],
)
def test_experiment_parameters_outside_their_range_are_rejected(body):
    assert client.post("/api/experiments/run", json=body).status_code == 422


def test_an_unknown_scenario_falls_back_rather_than_failing():
    """Documented behaviour: the harness picks the default scenario. If this
    ever starts 500ing, the site's dropdown and the API have diverged."""
    response = client.post(
        "/api/experiments/run",
        json={"scenario": "no-such-scenario", "ticks": 60, "repeats": 1},
    )
    assert response.status_code == 200
    assert response.json()["scenario"]["key"] == "normal"


@pytest.mark.parametrize("seed", [-999_999, 2**40])
def test_extreme_seeds_still_produce_sane_results(seed):
    response = client.post(
        "/api/experiments/run", json={"ticks": 60, "seed": seed, "repeats": 1}
    )
    assert response.status_code == 200

    overhead = response.json()["headline"]["message_overhead"]
    assert overhead["baseline"] >= 0
    assert overhead["proposed"] >= 0


# -------------------------------------------------------------- ops surface
def test_metrics_exposes_the_core_families():
    body = client.get("/metrics").text
    for family in ("v2x_simulation_ticks_total", "v2x_vehicles", "v2x_packet_delivery_ratio"):
        assert family in body
