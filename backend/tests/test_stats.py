"""Confidence intervals, and the harness actually using them."""
import math

import pytest

from app.config import EXP3_FULL
from app.experiments.runner import SCENARIOS, aggregate_runs, run_experiment, run_suite
from app.stats import Estimate, separated, summarize, t_multiplier


# ------------------------------------------------------------- t multiplier
def test_small_samples_use_student_t_not_the_normal_approximation():
    """At n=3 the normal multiplier understates the interval by more than 2x.
    Getting this wrong is how a simulation study claims a result it has not
    got."""
    assert t_multiplier(2) == pytest.approx(4.303)
    assert t_multiplier(2) > 1.96 * 2


def test_multiplier_tends_to_the_normal_value_for_large_samples():
    assert t_multiplier(1000) == pytest.approx(1.96, abs=0.01)
    assert t_multiplier(9) > t_multiplier(60) >= 1.96


def test_zero_degrees_of_freedom_has_no_interval():
    assert t_multiplier(0) == 0.0


# ----------------------------------------------------------------- estimates
def test_mean_and_interval_over_a_known_sample():
    values = [10.0, 12.0, 14.0]
    est = summarize(values)

    assert est.mean == pytest.approx(12.0)
    assert est.stdev == pytest.approx(2.0)
    # t(df=2) * s / sqrt(n)
    assert est.half_width == pytest.approx(4.303 * 2.0 / math.sqrt(3), rel=1e-3)
    assert est.low < est.mean < est.high


def test_identical_seeds_give_a_zero_width_interval():
    est = summarize([7.0, 7.0, 7.0, 7.0])
    assert est.mean == 7.0
    assert est.half_width == 0.0
    assert est.reportable


def test_one_seed_is_a_sample_not_a_result():
    est = summarize([42.0])
    assert est.n == 1
    assert not est.reportable
    assert est.half_width == 0.0


def test_empty_sample_does_not_explode():
    est = summarize([])
    assert est.n == 0
    assert est.mean == 0.0
    assert not est.reportable


def test_as_dict_carries_the_interval_not_just_the_mean():
    d = summarize([1.0, 2.0, 3.0]).as_dict()
    assert set(d) >= {"mean", "half_width", "low", "high", "stdev", "n", "reportable"}


# ---------------------------------------------------------------- separation
def test_overlapping_intervals_are_not_separated():
    a = summarize([10.0, 11.0, 12.0])
    b = summarize([11.0, 12.0, 13.0])
    assert not separated(a, b)


def test_clearly_distinct_samples_are_separated():
    a = summarize([1.0, 1.1, 0.9])
    b = summarize([50.0, 50.1, 49.9])
    assert separated(a, b)


def test_a_single_sample_can_never_claim_separation():
    assert not separated(Estimate(1.0, 0.0, 0.0, 1), Estimate(99.0, 0.0, 0.0, 1))


# ------------------------------------------------------------- harness usage
def test_aggregate_runs_summarizes_every_tracked_metric():
    scenario = SCENARIOS["normal"]
    runs = [run_experiment(EXP3_FULL, scenario, ticks=60, seed=s) for s in (1, 2)]
    agg = aggregate_runs(runs)

    assert agg["uplink_kilobytes_per_tick"].n == 2
    assert "f1" in agg and "availability_during_outage_pct" in agg


def test_suite_reports_intervals_and_reuses_the_same_seeds_everywhere():
    suite = run_suite(scenario_key="normal", ticks=60, seed=99, repeats=2)

    assert suite["repeats"] == 2
    assert suite["seeds"] == [99, 100]
    assert len(suite["aggregates"]) == 4

    overhead = suite["headline"]["message_overhead"]
    assert overhead["samples"] == 2
    assert "baseline_half_width" in overhead and "proposed_half_width" in overhead
    assert "separated" in overhead


def test_repeats_are_clamped_to_a_sane_range():
    suite = run_suite(scenario_key="normal", ticks=60, seed=5, repeats=0)
    assert suite["repeats"] == 1
