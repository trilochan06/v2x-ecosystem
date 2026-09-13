import pytest

from app.ai.congestion_model import CongestionPredictor
from app.simulation.world import CityGrid


@pytest.fixture(scope="module")
def predictor():
    return CongestionPredictor()


def test_prediction_is_bounded(predictor):
    grid = CityGrid(size=3)
    seg = next(iter(grid.segments.values()))
    seg.occupancy = 0.9
    seg.history = [0.8, 0.85, 0.9]
    seg.confirmed_incident = True
    result = predictor.predict(seg, tick=50)

    assert 0.0 <= result["predicted_occupancy"] <= 1.0
    assert result["risk_level"] in {"low", "moderate", "high"}
    assert result["top_factor"] in {
        "lag1",
        "lag2",
        "lag3",
        "time_sin",
        "time_cos",
        "incident_flag",
        "neighbor_avg",
    }
    assert result["explanation"]


def test_congested_history_predicts_higher_than_clear_history(predictor):
    grid = CityGrid(size=3)
    congested = next(iter(grid.segments.values()))
    congested.occupancy = 0.95
    congested.history = [0.9, 0.92, 0.95]
    congested.confirmed_incident = True

    clear = list(grid.segments.values())[1]
    clear.occupancy = 0.05
    clear.history = [0.05, 0.05, 0.05]
    clear.confirmed_incident = False

    congested_pred = predictor.predict(congested, tick=50)
    clear_pred = predictor.predict(clear, tick=50)

    assert congested_pred["predicted_occupancy"] > clear_pred["predicted_occupancy"]
