from app.network.gossip import EtherBus, RecipientHandle
from app.network.messages import Message, MessageType
from app.simulation.world import CityGrid


def make_bus():
    grid = CityGrid(size=4)
    bus = EtherBus(grid)
    return grid, bus


def test_message_reaches_recipient_within_ttl_hops():
    grid, bus = make_bus()
    msg = Message(type=MessageType.HAZARD_REPORT, sender_id="v1", payload={"segment_id": "x"}, ttl=2)
    recipients = [RecipientHandle(node_id="v2", grid_node="2-0"), RecipientHandle(node_id="v3", grid_node="3-0")]
    delivered = bus.broadcast(msg, origin_grid_node="0-0", tick=1, recipients=recipients)
    assert "v2" in delivered  # 2 hops away, within ttl
    assert "v3" not in delivered  # 3 hops away, beyond ttl


def test_dead_recipient_never_receives_message():
    grid, bus = make_bus()
    msg = Message(type=MessageType.HAZARD_REPORT, sender_id="v1", payload={"segment_id": "x"}, ttl=5)
    recipients = [RecipientHandle(node_id="rsu-1", grid_node="1-0", is_alive=False)]
    delivered = bus.broadcast(msg, origin_grid_node="0-0", tick=1, recipients=recipients)
    assert delivered == []


def test_duplicate_message_delivered_only_once():
    grid, bus = make_bus()
    msg = Message(type=MessageType.HAZARD_REPORT, sender_id="v1", payload={"segment_id": "x"}, ttl=3)
    recipients = [RecipientHandle(node_id="v2", grid_node="1-0")]

    first = bus.broadcast(msg, origin_grid_node="0-0", tick=1, recipients=recipients)
    second = bus.broadcast(msg, origin_grid_node="0-0", tick=2, recipients=recipients)

    assert first == ["v2"]
    assert second == []  # dedup cache stops the re-delivery / relay storm
