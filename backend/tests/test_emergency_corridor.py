from app.emergency.corridor import EmergencyCorridorManager
from app.simulation.traffic_light import TrafficLight
from app.simulation.vehicle import Vehicle
from app.simulation.world import CityGrid


def test_corridor_preempts_lights_and_issues_yield_instructions():
    grid = CityGrid(size=4)
    ambulance = Vehicle(id="amb-1", kind="ambulance", grid=grid, node="0-0", destination="3-0")
    ambulance.route = ["0-0", "1-0", "2-0", "3-0"]

    blocker = Vehicle(id="car-1", kind="car", grid=grid, node="0-0", destination="0-3")
    blocker.route = ["0-0", "1-0"]  # sitting on the ambulance's first segment

    lights = {"1-0": TrafficLight(id="light-1-0", node="1-0")}

    mgr = EmergencyCorridorManager(grid=grid)
    instructions = mgr.step(
        tick=1, ambulances=[ambulance], all_vehicles=[ambulance, blocker], traffic_lights=lights
    )

    assert lights["1-0"].preempted_until >= 1
    assert any(i["vehicle_id"] == "car-1" for i in instructions)
    assert blocker.yield_instruction is not None
    assert "amb-1" in mgr.active_corridors


def test_vehicle_clears_yield_once_outside_corridor():
    grid = CityGrid(size=4)
    ambulance = Vehicle(id="amb-1", kind="ambulance", grid=grid, node="0-0", destination="3-0")
    ambulance.route = ["0-0", "1-0", "2-0", "3-0"]

    far_vehicle = Vehicle(id="car-2", kind="car", grid=grid, node="0-3", destination="3-3")
    far_vehicle.route = ["0-3", "1-3"]

    mgr = EmergencyCorridorManager(grid=grid)
    mgr.step(tick=1, ambulances=[ambulance], all_vehicles=[ambulance, far_vehicle], traffic_lights={})

    assert far_vehicle.yield_instruction is None
