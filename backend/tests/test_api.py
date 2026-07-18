from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_health():
    res = client.get("/api/health")
    assert res.status_code == 200
    assert res.json()["status"] == "ok"


def test_state_snapshot_shape():
    res = client.get("/api/state")
    body = res.json()
    assert "tick" in body
    assert "vehicles" in body
    assert "rsus" in body
    assert "segments" in body


def test_spawn_ambulance_and_toggle_rsu():
    res = client.post("/api/emergency/spawn")
    assert res.status_code == 200
    assert res.json()["vehicle_id"].startswith("ambulance-")

    state = client.get("/api/state").json()
    rsu_id = state["rsus"][0]["id"]

    res = client.post(f"/api/faults/rsu/{rsu_id}/toggle", json={"alive": False})
    assert res.status_code == 200
    assert res.json()["alive"] is False

    res = client.post(f"/api/faults/rsu/{rsu_id}/toggle", json={"alive": True})
    assert res.status_code == 200


def test_unknown_rsu_returns_404():
    res = client.post("/api/faults/rsu/does-not-exist/toggle", json={"alive": False})
    assert res.status_code == 404


def test_segment_prediction():
    state = client.get("/api/state").json()
    seg_id = state["segments"][0]["id"]
    res = client.get(f"/api/segments/{seg_id}/prediction")
    assert res.status_code == 200
    body = res.json()
    assert 0.0 <= body["predicted_occupancy"] <= 1.0
