from app.simulation.fog import build_fog_clusters
from app.simulation.rsu import RSU
from app.simulation.world import CityGrid


def test_fog_clusters_are_geographically_coherent():
    rsu_ids = ["rsu-1", "rsu-2", "rsu-3", "rsu-4"]
    coords = {
        "rsu-1": (0.0, 0.0),
        "rsu-2": (5.0, 0.0),
        "rsu-3": (0.0, 5.0),
        "rsu-4": (5.0, 5.0),
    }
    clusters = build_fog_clusters(rsu_ids, coords, cluster_size=2)

    assert len(clusters) == 2
    # sorted by (x, y) before chunking, so each cluster shares an x side
    xs = [{coords[r][0] for r in c.member_rsu_ids} for c in clusters]
    assert all(len(s) == 1 for s in xs)


def test_fog_node_raises_alert_on_regional_congestion():
    grid = CityGrid(size=4)
    rsu = RSU(id="rsu-1", node="0-0", grid=grid)
    for seg in rsu.local_segments():
        seg.occupancy = 0.9

    from app.network.rsu_network import RSUNetwork
    from app.simulation.fog import FogNode

    network = RSUNetwork()
    network.register_rsu("rsu-1", "0-0")
    fog = FogNode(id="fog-1", member_rsu_ids=["rsu-1"], x=0.0, y=0.0)

    summary = fog.aggregate(tick=20, rsus={"rsu-1": rsu}, rsu_network=network)

    assert summary is not None
    assert fog.alert is True
    assert summary.avg_occupancy > 0.6


def test_fog_node_no_alert_when_clear():
    grid = CityGrid(size=4)
    rsu = RSU(id="rsu-1", node="0-0", grid=grid)

    from app.network.rsu_network import RSUNetwork
    from app.simulation.fog import FogNode

    network = RSUNetwork()
    network.register_rsu("rsu-1", "0-0")
    fog = FogNode(id="fog-1", member_rsu_ids=["rsu-1"], x=0.0, y=0.0)

    fog.aggregate(tick=20, rsus={"rsu-1": rsu}, rsu_network=network)

    assert fog.alert is False


def test_fog_aggregate_returns_none_when_all_members_down():
    grid = CityGrid(size=4)
    rsu = RSU(id="rsu-1", node="0-0", grid=grid, alive=False)

    from app.network.rsu_network import RSUNetwork
    from app.simulation.fog import FogNode

    network = RSUNetwork()
    fog = FogNode(id="fog-1", member_rsu_ids=["rsu-1"], x=0.0, y=0.0)

    summary = fog.aggregate(tick=20, rsus={"rsu-1": rsu}, rsu_network=network)

    assert summary is None
    assert fog.alert is False
