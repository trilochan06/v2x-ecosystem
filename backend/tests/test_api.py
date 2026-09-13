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


def test_inject_hazard_on_named_segment():
    state = client.get("/api/state").json()
    seg_id = state["segments"][3]["id"]

    res = client.post(f"/api/hazards/{seg_id}")
    assert res.status_code == 200

    after = client.get("/api/state").json()
    segment = next(s for s in after["segments"] if s["id"] == seg_id)
    assert segment["hazard_active"] is True


def test_unknown_segment_hazard_returns_404():
    assert client.post("/api/hazards/not-a-segment").status_code == 404


def test_reference_exposes_layers_and_modules():
    body = client.get("/api/reference").json()
    assert len(body["layers"]) == 6
    assert len(body["modules"]) == 12
    assert body["team"]["mentor"] == "Dr. Malathi"


def test_architecture_switch_changes_active_config():
    res = client.post("/api/architecture/switch", json={"key": "exp1_centralized"})
    assert res.status_code == 200
    assert client.get("/api/state").json()["config"]["v2v_enabled"] is False

    client.post("/api/architecture/switch", json={"key": "exp3_full"})
    assert client.get("/api/state").json()["config"]["v2v_enabled"] is True


def test_unknown_architecture_returns_404():
    assert client.post("/api/architecture/switch", json={"key": "nope"}).status_code == 404


def test_replay_attack_is_blocked():
    body = client.post("/api/attacks/replay").json()
    assert body["blocked"] >= 1


def test_cloud_outage_toggle():
    assert client.post("/api/faults/cloud", json={"online": False}).json()["cloud_online"] is False
    assert client.get("/api/state").json()["cloud_online"] is False
    client.post("/api/faults/cloud", json={"online": True})
    assert client.get("/api/state").json()["cloud_online"] is True


def test_experiment_sweep_endpoint():
    res = client.post("/api/experiments/run", json={"scenario": "normal", "ticks": 120, "seed": 5})
    assert res.status_code == 200
    body = res.json()
    assert len(body["runs"]) == 3
    assert "headline" in body
