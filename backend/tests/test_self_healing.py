from app.network.rsu_network import RSUNetwork
from app.simulation.world import CityGrid


def test_vehicle_reassigned_when_rsu_goes_down():
    grid = CityGrid(size=5)
    net = RSUNetwork()
    net.register_rsu("rsu-near", "0-0")
    net.register_rsu("rsu-far", "4-4")

    cell = net.assign_vehicle(grid, "car-1", "0-0", tick=0)
    assert cell == "rsu-near"

    net.set_alive("rsu-near", False)
    new_cell = net.assign_vehicle(grid, "car-1", "0-0", tick=1)

    assert new_cell == "rsu-far"
    assert net.handover_log[-1]["vehicle_id"] == "car-1"
    assert net.handover_log[-1]["from"] == "rsu-near"
    assert net.handover_log[-1]["to"] == "rsu-far"


def test_vehicle_stays_on_same_rsu_while_it_is_alive():
    grid = CityGrid(size=5)
    net = RSUNetwork()
    net.register_rsu("rsu-a", "0-0")
    net.register_rsu("rsu-b", "4-4")

    net.assign_vehicle(grid, "car-1", "0-0", tick=0)
    cell = net.assign_vehicle(grid, "car-1", "1-0", tick=1)

    assert cell == "rsu-a"
    assert net.handover_log == []
