import random

import pytest


@pytest.fixture(autouse=True)
def _seeded_random():
    random.seed(1234)
    yield
