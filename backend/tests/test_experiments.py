import pytest

from app.config import EXP1_CENTRALIZED, EXP3_FULL
from app.experiments.runner import SCENARIOS, run_experiment, run_suite
from app.metrics import MetricsCollector


@pytest.fixture(scope="module")
def suite():
    return run_suite("normal", ticks=160, seed=4242)


def test_suite_runs_every_configuration(suite):
    keys = [r["config"]["key"] for r in suite["runs"]]
    assert keys == [
        "exp1_centralized",
        "exp2_v2x_no_edge_ai",
        "exp3_full",
        "exp4_coordinated",
    ]


def test_centralized_baseline_loses_service_during_outage(suite):
    baseline = suite["runs"][0]["metrics"]["resilience"]
    proposed = suite["runs"][2]["metrics"]["resilience"]

    assert baseline["outage_ticks"] > 0  # the outage actually happened
    assert baseline["availability_during_outage_pct"] == 0.0
    assert proposed["availability_during_outage_pct"] == 100.0


def test_edge_architecture_uses_far_less_uplink(suite):
    baseline = suite["runs"][0]["metrics"]["communication"]["uplink_kilobytes_per_tick"]
    proposed = suite["runs"][2]["metrics"]["communication"]["uplink_kilobytes_per_tick"]

    assert proposed < baseline / 5


def test_only_the_full_architecture_runs_federated_rounds(suite):
    assert suite["runs"][0]["federated"]["rounds_completed"] == 0
    assert suite["runs"][2]["federated"]["rounds_completed"] > 0


def test_headline_reports_every_comparison(suite):
    headline = suite["headline"]
    assert set(headline) == {"alert_latency", "message_overhead", "availability_during_outage"}
    for entry in headline.values():
        assert "baseline" in entry and "proposed" in entry and "unit" in entry


def test_detection_is_scored_against_ground_truth_not_belief():
    """A configuration that confirms fabricated hazards must be penalised,
    so precision has to be able to fall below 1."""
    run = run_experiment(EXP3_FULL, SCENARIOS["attack"], ticks=160, seed=7)
    detection = run["metrics"]["detection"]
    assert detection["true_positives"] + detection["false_positives"] > 0
    assert 0.0 <= detection["precision"] <= 1.0
    assert 0.0 <= detection["recall"] <= 1.0


def test_centralized_alerts_are_not_faster_than_edge_alerts():
    base = run_experiment(EXP1_CENTRALIZED, SCENARIOS["normal"], ticks=200, seed=11)
    full = run_experiment(EXP3_FULL, SCENARIOS["normal"], ticks=200, seed=11)

    base_latency = base["metrics"]["communication"]["avg_alert_latency_ticks"]
    full_latency = full["metrics"]["communication"]["avg_alert_latency_ticks"]
    assert base_latency >= full_latency


def test_metrics_ratios_are_safe_when_nothing_happened():
    summary = MetricsCollector().summary()
    assert summary["communication"]["packet_delivery_ratio"] == 0.0
    assert summary["detection"]["precision"] == 0.0
    assert summary["resilience"]["availability_pct"] == 0.0


def test_unwitnessed_report_does_not_count_as_a_miss():
    m = MetricsCollector()
    m.hazard_raised("seg-1", "accident", tick=0)
    m.incident_confirmed("seg-1", tick=4, hazard_active=True)
    m.hazard_cleared("seg-1")

    detection = m.summary()["detection"]
    assert detection["hazards_detected"] == 1
    assert detection["hazards_missed"] == 0
    assert detection["precision"] == 1.0


def test_false_confirmation_hurts_precision():
    m = MetricsCollector()
    m.incident_confirmed("seg-1", tick=4, hazard_active=False)
    assert m.summary()["detection"]["precision"] == 0.0
