"""Liveness, readiness, metrics exposition and structured logs."""
import json
import logging

from fastapi.testclient import TestClient

from app.main import app
from app.observability import JsonLogFormatter, render_prometheus, request_id_var
from app.runtime import get_engine

client = TestClient(app)


# --------------------------------------------------------------- endpoints
def test_health_is_cheap_and_always_answers():
    r = client.get("/health")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_ready_reports_starting_before_the_tick_loop_runs():
    """Outside the lifespan there is no tick task, so the instance must not
    claim it can take traffic."""
    r = client.get("/ready")
    assert r.status_code == 503
    assert r.json()["status"] == "starting"


def test_ready_is_true_once_the_app_has_started():
    with TestClient(app) as started:
        r = started.get("/ready")
        assert r.status_code == 200
        assert r.json()["status"] == "ready"


def test_metrics_are_served_in_prometheus_exposition_format():
    r = client.get("/metrics")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/plain")

    body = r.text
    assert "# HELP v2x_simulation_ticks_total" in body
    assert "# TYPE v2x_simulation_ticks_total counter" in body
    assert "v2x_packet_delivery_ratio" in body


def test_every_metric_line_is_a_comment_or_a_sample():
    body = render_prometheus(get_engine().state_snapshot())
    for line in body.strip().splitlines():
        if line.startswith("#"):
            continue
        name, _, value = line.rpartition(" ")
        assert name, line
        float(value)  # must parse, or a scraper rejects the whole payload


def test_labelled_families_render_their_labels():
    state = get_engine().state_snapshot()
    state["metrics"]["communication"]["frames_by_designator"] = {"CAM": 12, "DENM": 3}
    body = render_prometheus(state)

    assert 'v2x_frames_total{designator="CAM"} 12' in body
    assert 'v2x_frames_total{designator="DENM"} 3' in body


def test_ops_endpoints_are_not_shadowed_by_the_spa_fallback():
    """The catch-all route that serves index.html is registered last; if that
    ordering ever breaks, /health starts returning HTML."""
    assert client.get("/health").headers["content-type"].startswith("application/json")


# ------------------------------------------------------------------- logging
def test_logs_are_single_line_json():
    record = logging.LogRecord(
        name="v2x.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="hello %s", args=("world",), exc_info=None,
    )
    line = JsonLogFormatter().format(record)

    assert "\n" not in line
    payload = json.loads(line)
    assert payload["message"] == "hello world"
    assert payload["level"] == "INFO"
    assert payload["logger"] == "v2x.test"


def test_request_id_travels_into_the_log_line():
    token = request_id_var.set("abc123")
    try:
        record = logging.LogRecord(
            name="v2x.test", level=logging.INFO, pathname=__file__, lineno=1,
            msg="x", args=(), exc_info=None,
        )
        assert json.loads(JsonLogFormatter().format(record))["request_id"] == "abc123"
    finally:
        request_id_var.reset(token)


def test_extra_fields_are_merged_into_the_payload():
    record = logging.LogRecord(
        name="v2x.test", level=logging.INFO, pathname=__file__, lineno=1,
        msg="request", args=(), exc_info=None,
    )
    record.extra_fields = {"status": 200, "path": "/api/state"}
    payload = json.loads(JsonLogFormatter().format(record))

    assert payload["status"] == 200
    assert payload["path"] == "/api/state"


def test_responses_carry_a_request_id_header():
    r = client.get("/health")
    assert r.headers.get("X-Request-ID")


def test_a_supplied_request_id_is_echoed_back():
    r = client.get("/health", headers={"X-Request-ID": "trace-me"})
    assert r.headers["X-Request-ID"] == "trace-me"
