"""Rooms without sockets (server/rooms.py): Peers are plain objects whose outbox we read."""

from __future__ import annotations

import asyncio
import json

import pytest
from pycrdt import Doc, Map, YMessageType, create_sync_message, create_update_message, handle_sync_message

from server.rooms import Loaded, Peer, Room, RoomRegistry

PAYLOAD = {"nodes": [{"id": "a", "label": "A", "notes": "", "x": 0, "y": 0, "z": 0}], "edges": []}


class MemoryStore:
    def __init__(self, payload=PAYLOAD):
        self.payload, self.ydoc, self.epoch, self.revision, self.saves = payload, None, None, 1, []
        self.fail = False

    def load(self, map_id):
        return Loaded(self.ydoc, self.epoch, self.payload, self.revision, "Galaxy", None)

    def save(self, map_id, ydoc, epoch, payload, base_revision):
        if self.fail:
            raise OSError("disk full")
        if base_revision != self.revision:
            return None
        self.ydoc, self.epoch, self.payload = ydoc, epoch, payload
        self.revision += 1
        self.saves.append(payload)
        return self.revision


def peer(name="ed", role="editor", conn=None):
    return Peer(conn=conn or name, name=name, role=role, perms={}, guest=False, user_id=None, guest_key=None)


def drain(p):
    items = []
    while not p.outbox.empty():
        items.append(p.outbox.get_nowait())
    return items


def texts(p):
    return [json.loads(item[1]) for item in drain(p) if item[0] == "text"]


async def answer_handshake(room, p, client):
    """Client side of the handshake, as roomClient.js does it: answer the
    server's step1 with our step2, then send our own step1 and apply the
    server's step2 (the map)."""
    for kind, *rest in drain(p):
        if kind == "bytes" and rest[0][0] == YMessageType.SYNC:
            reply = handle_sync_message(rest[0][1:], client)
            if reply:
                await room.on_binary(p, reply)
    await room.on_binary(p, create_sync_message(client))
    for kind, *rest in drain(p):
        if kind == "bytes" and rest[0][0] == YMessageType.SYNC:
            handle_sync_message(rest[0][1:], client)


async def joined(room, p, epoch=""):
    assert await room.join(p, epoch)
    client = Doc()
    await answer_handshake(room, p, client)
    return client


def edit_message(client: Doc, fn):
    """Run fn on the client doc and return the update frame it would send."""
    updates = []
    sub = client.observe(lambda event: updates.append(event.update))
    fn(client)
    client.unobserve(sub)
    return create_update_message(updates[-1])


def set_label(value):
    return lambda d: d.get("nodes", type=Map)["a"].__setitem__("label", value)


@pytest.fixture
def store():
    return MemoryStore()


@pytest.mark.anyio
async def test_join_sends_welcome_and_sync(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    p = peer()
    assert await room.join(p, "")
    items = drain(p)
    welcome = json.loads(items[0][1])
    assert welcome["type"] == "welcome" and welcome["you"]["role"] == "editor" and welcome["map"]["name"] == "Galaxy"
    assert welcome["epoch"] == room.epoch
    assert any(kind == "bytes" for kind, *_ in items)


@pytest.mark.anyio
async def test_the_handshake_gives_the_client_the_map(store):
    room = Room("m", store)
    await room.open()
    p = peer()
    assert await room.join(p, "")
    client = Doc()
    # The client's own step1 → the server's step2 carries the whole map.
    await room.on_binary(p, create_sync_message(client))
    for kind, *rest in drain(p):
        if kind == "bytes" and rest[0][0] == YMessageType.SYNC:
            handle_sync_message(rest[0][1:], client)
    assert client.get("nodes", type=Map)["a"]["label"] == "A"


@pytest.mark.anyio
async def test_editor_update_reaches_other_peers_and_persists(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    a, b = peer("a"), peer("b")
    client_a = await joined(room, a)
    await joined(room, b)
    drain(b)
    await room.on_binary(a, edit_message(client_a, set_label("Alpha")))
    assert any(kind == "bytes" for kind, *_ in drain(b))
    assert not any(kind == "bytes" for kind, *_ in drain(a))  # not echoed to its sender
    await asyncio.sleep(0.05)
    assert store.saves and store.saves[-1]["nodes"][0]["label"] == "Alpha"
    assert store.epoch == room.epoch and store.ydoc


@pytest.mark.anyio
async def test_opening_and_leaving_without_edits_writes_nothing(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    a = peer("a")
    await joined(room, a)
    await room.leave(a)
    await asyncio.sleep(0.05)
    assert store.saves == []


@pytest.mark.anyio
async def test_a_stored_ydoc_is_reopened_with_its_epoch(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    a = peer("a")
    client = await joined(room, a)
    await room.on_binary(a, edit_message(client, set_label("Kept")))
    await room.leave(a)
    again = Room("m", store)
    await again.open()
    assert again.epoch == room.epoch
    assert again.doc.get("nodes", type=Map)["a"]["label"] == "Kept"


@pytest.mark.anyio
async def test_review_focus_5_viewer_update_is_dropped(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    v = peer("v", role="viewer")
    client = await joined(room, v)
    assert {"type": "read_only"} not in texts(v)  # its empty handshake reply is not an edit
    await room.on_binary(v, edit_message(client, set_label("hacked")))
    assert {"type": "read_only"} in texts(v)
    await asyncio.sleep(0.05)
    assert store.saves == [] and room.doc.get("nodes", type=Map)["a"]["label"] == "A"


@pytest.mark.anyio
async def test_malformed_node_update_closes_the_connection_and_is_not_applied(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    p = peer()
    client = await joined(room, p)
    frame = edit_message(client, lambda d: d.get("nodes", type=Map)["a"].__setitem__("x", "not a number"))
    await room.on_binary(p, frame)
    assert ("close", 4400) in [(kind, rest[0]) for kind, *rest in drain(p) if kind == "close"]
    assert room.doc.get("nodes", type=Map)["a"]["x"] == 0
    # The room still takes good edits from others afterwards.
    q = peer("q")
    other = await joined(room, q)
    await room.on_binary(q, edit_message(other, set_label("fine")))
    assert room.doc.get("nodes", type=Map)["a"]["label"] == "fine"


@pytest.mark.anyio
async def test_garbage_bytes_close_the_connection(store):
    room = Room("m", store)
    await room.open()
    p = peer()
    await joined(room, p)
    await room.on_binary(p, b"\x00\x02\x05\xff\xff\xff\xff\xff")
    assert any(kind == "close" and rest[0] == 4400 for kind, *rest in drain(p))


@pytest.mark.anyio
async def test_stale_epoch_gets_reload(store):
    room = Room("m", store)
    await room.open()
    p = peer()
    assert not await room.join(p, "some-old-epoch")
    kinds = drain(p)
    assert json.loads(kinds[0][1])["type"] == "reload" and kinds[-1][:2] == ("close", 4409)


@pytest.mark.anyio
async def test_someone_else_wrote_the_map_so_the_room_reloads_everyone(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    a = peer("a")
    client = await joined(room, a)
    store.revision += 1  # a restore landed via Flask
    await room.on_binary(a, edit_message(client, set_label("x")))
    await asyncio.sleep(0.05)
    assert any(t["type"] == "reload" for t in texts(a))
    assert room.closed


@pytest.mark.anyio
async def test_persist_failures_are_reported_then_recovery(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    a = peer("a")
    client = await joined(room, a)
    store.fail = True
    for i in range(3):
        await room.on_binary(a, edit_message(client, set_label(f"v{i}")))
        await asyncio.sleep(0.05)
    assert {"type": "error", "code": "not_saved"} in texts(a)
    store.fail = False
    await room.on_binary(a, edit_message(client, set_label("ok")))
    await asyncio.sleep(0.05)
    assert {"type": "saved"} in texts(a)


@pytest.mark.anyio
async def test_review_focus_3_shutdown_persists_unsaved_edits(store):
    registry = RoomRegistry(store)
    registry.bind_loop(asyncio.get_running_loop())
    a = peer("a")
    room = await registry.join("m", a, "")
    assert room is not None
    client = Doc()
    await answer_handshake(room, a, client)
    room.persist_delay = 60  # would not save on its own in time
    await room.on_binary(a, edit_message(client, set_label("late")))
    await registry.shutdown()
    assert store.saves[-1]["nodes"][0]["label"] == "late"


@pytest.mark.anyio
async def test_colours_are_distinct_and_roster_lists_people(store):
    room = Room("m", store)
    await room.open()
    a, b = peer("a"), peer("b")
    await room.join(a, "")
    await room.join(b, "")
    assert a.colour != b.colour
    roster = [t for t in texts(a) if t["type"] == "roster"][-1]
    assert sorted(p["name"] for p in roster["people"]) == ["a", "b"]


@pytest.mark.anyio
async def test_awareness_is_relayed_and_ids_are_claimed(store):
    from pycrdt import Awareness, create_awareness_message

    room = Room("m", store)
    await room.open()
    a, b = peer("a"), peer("b")
    await joined(room, a)
    await joined(room, b)
    drain(b)
    mine = Doc()
    awareness = Awareness(mine)
    awareness.set_local_state({"pose": {"p": [1, 2, 3]}})
    frame = create_awareness_message(awareness.encode_awareness_update([mine.client_id]))
    await room.on_binary(a, frame)
    assert a.client_ids == {mine.client_id}
    assert ("bytes", frame) in drain(b)
    # b may not speak for a's client id.
    await room.on_binary(b, frame)
    assert b.client_ids == set()


@pytest.mark.anyio
async def test_registry_refuses_the_eleventh_person(store):
    registry = RoomRegistry(store, max_people=10)
    registry.bind_loop(asyncio.get_running_loop())
    for i in range(10):
        assert await registry.join("m", peer(f"p{i}"), "") is not None
    extra = peer("extra")
    assert await registry.join("m", extra, "") is None
    assert drain(extra)[-1][:2] == ("close", 4429)


@pytest.mark.anyio
async def test_registry_online_lists_who_is_in_each_map(store):
    registry = RoomRegistry(store)
    registry.bind_loop(asyncio.get_running_loop())
    await registry.join("m", peer("a"), "")
    assert [p["name"] for p in registry.online(["m", "other"])["m"]] == ["a"]
    assert "other" not in registry.online(["m", "other"])


@pytest.mark.anyio
async def test_notify_reaches_the_room_from_another_thread(store):
    registry = RoomRegistry(store)
    registry.bind_loop(asyncio.get_running_loop())
    a = peer("a")
    await registry.join("m", a, "")
    await asyncio.to_thread(registry.notify, "m", "deleted")
    await asyncio.sleep(0.05)
    assert any(t["type"] == "deleted" for t in texts(a))
    assert "m" not in registry.rooms


@pytest.mark.anyio
async def test_deleted_tells_everyone_and_closes(store):
    room = Room("m", store)
    await room.open()
    a = peer("a")
    await room.join(a, "")
    await room.deleted()
    items = drain(a)
    assert any(kind == "text" and json.loads(rest[0])["type"] == "deleted" for kind, *rest in items)
    assert items[-1][0] == "close"


@pytest.mark.anyio
async def test_flush_saves_now_and_answers(store):
    room = Room("m", store, persist_delay=60)
    await room.open()
    a = peer("a")
    client = await joined(room, a)
    await room.on_binary(a, edit_message(client, set_label("now")))
    await room.on_text(a, {"type": "flush"})
    assert store.saves[-1]["nodes"][0]["label"] == "now"
    assert {"type": "flushed", "ok": True} in texts(a)


@pytest.mark.anyio
async def test_flush_that_cannot_save_says_so(store):
    room = Room("m", store, persist_delay=60)
    await room.open()
    a = peer("a")
    client = await joined(room, a)
    await room.on_binary(a, edit_message(client, set_label("now")))
    store.fail = True
    await room.on_text(a, {"type": "flush"})
    assert {"type": "flushed", "ok": False} in texts(a)
