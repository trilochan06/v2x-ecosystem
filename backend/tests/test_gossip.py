from app.network.gossip import EtherBus, RecipientHandle
from app.network.messages import Message, MessageType
from app.simulation.world import CityGrid


def make_bus(seed: int = 1):
    grid = CityGrid(size=4)
    return grid, EtherBus(grid, seed=seed)


def perfect_link(bus):
    """Force a lossless channel so range/dedup assertions aren't flaky."""
    bus._delivery_probability = lambda _hops, _load: 1.0


def test_message_reaches_recipient_within_ttl_hops():
    _grid, bus = make_bus()
    perfect_link(bus)
    msg = Message(type=MessageType.DENM_HAZARD, sender_id="v1", payload={"segment_id": "x"}, ttl=2)
    recipients = [
        RecipientHandle(node_id="v2", grid_node="2-0"),
        RecipientHandle(node_id="v3", grid_node="3-0"),
    ]

    delivered, intended = bus.broadcast(msg, "0-0", tick=1, recipients=recipients)

    assert "v2" in delivered  # 2 hops away, within ttl
    assert "v3" not in delivered  # 3 hops away, beyond ttl
    assert intended == 1  # only the in-range node was ever a candidate


def test_dead_recipient_never_receives_message():
    _grid, bus = make_bus()
    perfect_link(bus)
    msg = Message(type=MessageType.DENM_HAZARD, sender_id="v1", payload={"segment_id": "x"}, ttl=5)
    recipients = [RecipientHandle(node_id="rsu-1", grid_node="1-0", is_alive=False)]

    delivered, intended = bus.broadcast(msg, "0-0", tick=1, recipients=recipients)

    assert delivered == []
    assert intended == 0


def test_duplicate_message_delivered_only_once():
    _grid, bus = make_bus()
    perfect_link(bus)
    msg = Message(type=MessageType.DENM_HAZARD, sender_id="v1", payload={"segment_id": "x"}, ttl=3)
    recipients = [RecipientHandle(node_id="v2", grid_node="1-0")]

    first, _ = bus.broadcast(msg, "0-0", tick=1, recipients=recipients)
    second, _ = bus.broadcast(msg, "0-0", tick=2, recipients=recipients)

    assert first == ["v2"]
    assert second == []  # dedup cache stops the relay storm


def test_contention_reduces_delivery_probability():
    """Denser channels must deliver less -- this is the mechanism behind the
    packet-delivery-ratio metric, so it needs to actually bite."""
    _grid, bus = make_bus()
    quiet = bus._delivery_probability(hops=1, channel_load=0.0)
    busy = bus._delivery_probability(hops=1, channel_load=1.0)

    assert quiet > busy
    assert busy >= 0.05  # never a completely dead channel


def test_further_hops_are_less_reliable():
    _grid, bus = make_bus()
    near = bus._delivery_probability(hops=1, channel_load=0.0)
    far = bus._delivery_probability(hops=4, channel_load=0.0)

    assert near > far


def test_message_size_includes_security_overhead():
    unsigned = Message(type=MessageType.CAM, sender_id="v1", payload={"segment_id": "0-0_1-0"})
    signed = Message(
        type=MessageType.CAM, sender_id="v1", payload={"segment_id": "0-0_1-0"}, signature="abc"
    )
    assert signed.size_bytes > unsigned.size_bytes
