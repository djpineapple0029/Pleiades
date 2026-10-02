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
async def test_registry_online_marks_guests(store):
    registry = RoomRegistry(store)
    registry.bind_loop(asyncio.get_running_loop())
    await registry.join("m", peer("ed"), "")
    guest = Peer(conn="g", name="sam", role="viewer", perms={}, guest=True, user_id=None, guest_key="k")
    await registry.join("m", guest, "")
    online = registry.online(["m"])["m"]
    assert [(p["name"], p["guest"]) for p in online] == [("ed", False), ("sam", True)]
    assert all(set(p) == {"name", "colour", "guest"} for p in online)  # nothing a list row shouldn't show


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


# --- Final review: updates the materialiser can't take never get in ----------


def add_node(key, fields, notes=True):
    def fn(d):
        with d.transaction():
            node = Map()
            d.get("nodes", type=Map)[key] = node
            for k, v in fields.items():
                node[k] = v
            if notes:
                from pycrdt import Text

                node["notes"] = Text("")

    return fn


GOOD = {"id": "zz", "label": "", "x": 0.0, "y": 0.0, "z": 0.0}


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("key", "fields", "notes"),
    [
        ("zz", {k: v for k, v in GOOD.items() if k != "id"}, True),  # no id
        ("zz", {**GOOD, "id": "other"}, True),  # id isn't its key
        ("zz", {**GOOD, "notes": "plain"}, False),  # notes not shared text
    ],
)
async def test_a_star_the_payload_could_not_hold_is_refused(store, key, fields, notes):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    p = peer()
    client = await joined(room, p)
    await room.on_binary(p, edit_message(client, add_node(key, fields, notes)))
    assert ("close", 4400) in [(kind, rest[0]) for kind, *rest in drain(p) if kind == "close"]
    assert "zz" not in room.doc.get("nodes", type=Map)


@pytest.mark.anyio
async def test_a_good_new_star_is_still_taken(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    p = peer()
    client = await joined(room, p)
    await room.on_binary(p, edit_message(client, add_node("zz", GOOD)))
    assert "zz" in room.doc.get("nodes", type=Map)


@pytest.mark.anyio
async def test_a_link_whose_id_is_not_its_key_is_refused(store):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    p = peer()
    client = await joined(room, p)

    def fn(d):
        with d.transaction():
            edge = Map()
            d.get("edges", type=Map)["e1"] = edge
            for k, v in {"id": "e2", "from": "a", "to": "a2", "directed": False, "label": ""}.items():
                edge[k] = v

    await room.on_binary(p, edit_message(client, fn))
    assert "e1" not in room.doc.get("edges", type=Map)


@pytest.mark.anyio
@pytest.mark.parametrize("root", ["meta", "evil"])
async def test_updates_to_meta_or_other_roots_are_refused(store, root):
    room = Room("m", store, persist_delay=0.01)
    await room.open()
    p = peer()
    client = await joined(room, p)
    await room.on_binary(p, edit_message(client, lambda d: d.get(root, type=Map).__setitem__("schema", 999)))
    assert ("close", 4400) in [(kind, rest[0]) for kind, *rest in drain(p) if kind == "close"]
    assert room.doc.get("meta", type=Map).get("schema") != 999


@pytest.mark.anyio
async def test_one_room_failing_to_save_does_not_stop_the_others_at_shutdown(store, monkeypatch):
    registry = RoomRegistry(store)
    registry.bind_loop(asyncio.get_running_loop())
    a, b = peer("a"), peer("b")
    room_a = await registry.join("m1", a, "")
    room_b = await registry.join("m2", b, "")
    client_b = Doc()
    await answer_handshake(room_b, b, client_b)
    room_b.persist_delay = 60
    await room_b.on_binary(b, edit_message(client_b, set_label("kept")))
    room_a._dirty = True
    monkeypatch.setattr(room_a, "doc", None)  # its save will blow up
    await registry.shutdown()
    assert store.saves and store.saves[-1]["nodes"][0]["label"] == "kept"


@pytest.mark.anyio
async def test_constant_editing_still_saves_within_the_maximum_wait(store):
    room = Room("m", store, persist_delay=0.05, persist_max_wait=0.12)
    await room.open()
    a = peer("a")
    client = await joined(room, a)
    for i in range(12):  # an edit every 30 ms: the debounce alone would never fire
        await room.on_binary(a, edit_message(client, set_label(f"v{i}")))
        await asyncio.sleep(0.03)
    assert store.saves


@pytest.mark.anyio
async def test_flush_answers_for_its_own_save_even_if_someone_edits_meanwhile(store):
    room = Room("m", store, persist_delay=60)
    await room.open()
    a, b = peer("a"), peer("b")
    client_a = await joined(room, a)
    client_b = await joined(room, b)
    await room.on_binary(a, edit_message(client_a, set_label("mine")))
    real_save = store.save

    def slow_save(*args):
        import time

        time.sleep(0.05)
        return real_save(*args)

    store.save = slow_save
    flushing = asyncio.ensure_future(room.on_text(a, {"type": "flush"}))
    await asyncio.sleep(0.01)
    await room.on_binary(b, edit_message(client_b, lambda d: d.get("nodes", type=Map)["a"].__setitem__("x", 3.0)))
    await flushing
    assert {"type": "flushed", "ok": True} in texts(a)


# --- Final review: removing or demoting someone reaches their open socket ----


@pytest.mark.anyio
async def test_access_changes_reach_people_already_in_the_room(store):
    from server.access import Access

    roles = {1: "editor", 2: "editor"}

    def resolve(map_id, p):
        role = roles.get(p.user_id)
        return Access(role, {"invite": role == "editor"}, 99, user_id=p.user_id) if role else None

    registry = RoomRegistry(store, resolve=resolve)
    registry.bind_loop(asyncio.get_running_loop())
    stays = Peer(conn="s", name="stays", role="editor", perms={}, guest=False, user_id=1, guest_key=None)
    goes = Peer(conn="g", name="goes", role="editor", perms={}, guest=False, user_id=2, guest_key=None)
    room = await registry.join("m", stays, "")
    await registry.join("m", goes, "")
    drain(stays)
    drain(goes)

    roles[1] = "viewer"
    del roles[2]
    await asyncio.to_thread(registry.notify, "m", "access")
    await asyncio.sleep(0.05)

    assert stays.role == "viewer" and not stays.can_edit
    assert {"type": "access", "role": "viewer", "perms": {"invite": False}} in texts(stays)
    gone = drain(goes)
    assert any(kind == "text" and json.loads(rest[0])["type"] == "kicked" for kind, *rest in gone)
    assert gone[-1][:2] == ("close", 4403)
    assert [p.name for p in room.peers] == ["stays"]


# --- Milestone 2: re-checking everyone, guests included ---------------------


@pytest.mark.anyio
async def test_reaccess_demotes_and_kicks(store):
    from server.access import Access

    room = Room("m", store)
    await room.open()
    keep, demote, drop = peer("keep"), peer("demote"), peer("drop")
    drop.guest, drop.guest_key, drop.link_token = True, "k" * 22, "tok"
    for p in (keep, demote, drop):
        await room.join(p, "")
        drain(p)

    def resolver(map_id, p):
        if p is drop:
            return None
        if p is demote:
            return Access("viewer", {"chat": False}, owner_id=1)
        return Access("editor", {"chat": True}, owner_id=1)

    await room.reaccess(resolver)
    assert {"type": "access", "role": "viewer", "perms": {"chat": False}} in texts(demote)
    kicked = drain(drop)
    assert any(k == "text" and json.loads(r[0])["type"] == "kicked" for k, *r in kicked)
    assert drop not in room.peers and demote.role == "viewer"


@pytest.mark.anyio
async def test_review_focus_5_a_removed_peers_late_frames_are_ignored(store):
    room = Room("m", store)
    await room.open()
    gone = peer("gone")
    client = await joined(room, gone)
    await room.leave(gone)
    gone.closing = False  # a frame that was already in flight when they were removed
    await room.on_binary(gone, edit_message(client, set_label("late")))
    assert room.doc.get("nodes", type=Map)["a"]["label"] == "A"


@pytest.mark.anyio
async def test_review_focus_5_a_kicked_peers_in_flight_frame_is_not_applied(store):
    room = Room("m", store)
    await room.open()
    owner, kicked = peer("owner", role="owner"), peer("kicked")
    await joined(room, owner)
    client = await joined(room, kicked)
    frame = edit_message(client, set_label("after the kick"))
    assert await room.kick("kicked", "kicked")
    assert kicked not in room.peers and [p.name for p in room.peers] == ["owner"]
    sent = drain(kicked)
    assert ("close", 4403, "kicked") in sent
    await room.on_binary(kicked, frame)
    assert room.doc.get("nodes", type=Map)["a"]["label"] == "A"
    assert not await room.kick("nobody", "kicked")


@pytest.mark.anyio
async def test_disconnect_user_sends_them_out_and_closes_maps_they_owned(store):
    registry = RoomRegistry(store)
    registry.bind_loop(asyncio.get_running_loop())
    leaving = Peer(conn="l", name="leaving", role="editor", perms={}, guest=False, user_id=7, guest_key=None)
    stays = Peer(conn="s", name="stays", role="editor", perms={}, guest=False, user_id=8, guest_key=None)
    other_map_guest = peer("guest")
    theirs = await registry.join("m", leaving, "")
    await registry.join("m", stays, "")
    owned = await registry.join("owned", other_map_guest, "")
    for p in (leaving, stays, other_map_guest):
        drain(p)

    await asyncio.to_thread(registry.disconnect_user, 7, ["owned"])
    await asyncio.sleep(0.05)

    gone = drain(leaving)
    assert {"type": "kicked", "reason": "account closed"} in [json.loads(r[0]) for k, *r in gone if k == "text"]
    assert gone[-1][:2] == ("close", 4403)
    assert [p.name for p in theirs.peers] == ["stays"]
    assert {"type": "deleted"} in texts(other_map_guest)
    assert owned.closed and "owned" not in registry.rooms


# --- Final review: an expiring link sends its guests out when it expires ------


@pytest.mark.anyio
async def test_a_guest_on_an_expired_link_cannot_edit(store):
    import time

    room = Room("m", store)
    await room.open()
    guest = peer("guest")
    guest.guest, guest.link_expires_at = True, time.time() + 60
    client = await joined(room, guest)
    guest.link_expires_at = time.time() - 1  # the link ran out while they were in
    await room.on_binary(guest, edit_message(client, set_label("after expiry")))
    assert room.doc.get("nodes", type=Map)["a"]["label"] == "A"
    assert guest not in room.peers
    assert ("close", 4403, "access removed") in drain(guest)


@pytest.mark.anyio
async def test_the_registry_rechecks_a_link_guest_when_their_link_expires(store):
    import time

    expired = []

    def resolve(map_id, p):
        expired.append(p.name)
        return None  # the link has expired by now

    registry = RoomRegistry(store, resolve=resolve)
    registry.bind_loop(asyncio.get_running_loop())
    guest = peer("guest")
    guest.guest, guest.link_expires_at = True, time.time() + 0.05
    await registry.join("m", guest, "")
    drain(guest)
    await asyncio.sleep(0.3)
    assert expired == ["guest"]
    assert ("close", 4403, "access removed") in drain(guest)


# --- chat (Task 3.1) ---------------------------------------------------------


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("text", "sent"),
    [
        ("hi", "hi"),
        ("<img src=x onerror=alert(1)>", "<img src=x onerror=alert(1)>"),  # text, never markup
        ("👩‍🚀 مرحبا", "👩‍🚀 مرحبا"),
        ("a\u0007b", "ab"),
        ("two\nlines", "two\nlines"),
        ("  padded  ", "padded"),
        ("é", "é"),  # NFC
        ("x" * 500, "x" * 500),
        ("x" * 501, None),
        ("   ", None),
        ("\u0007", None),
        (42, None),
        (None, None),
    ],
)
async def test_review_focus_4_chat_text(store, text, sent):
    room = Room("m", store)
    await room.open()
    a = Peer(conn="a", name="a", role="editor", perms={"chat": True}, guest=False, user_id=1, guest_key=None)
    b = peer("b")
    await room.join(a, "")
    await room.join(b, "")
    drain(a), drain(b)
    await room.on_text(a, {"type": "chat", "text": text})
    got = [t for t in texts(b) if t["type"] == "chat"]
    assert ([m["text"] for m in got] or [None]) == [sent]


@pytest.mark.anyio
async def test_chat_reaches_everyone_including_the_sender_with_who_sent_it(store):
    room = Room("m", store)
    await room.open()
    a = Peer(conn="a", name="Ari", role="editor", perms={"chat": True}, guest=False, user_id=1, guest_key=None)
    g = Peer(conn="g", name="Sam", role="viewer", perms={"chat": False}, guest=True, user_id=None, guest_key="k")
    await room.join(a, "")
    await room.join(g, "")
    drain(a), drain(g)
    await room.on_text(a, {"type": "chat", "text": "hello"})
    mine, theirs = texts(a), texts(g)
    assert mine == theirs
    (message,) = mine
    assert message["type"] == "chat" and message["conn"] == "a" and message["name"] == "Ari"
    assert message["colour"] == a.colour and message["guest"] is False and message["text"] == "hello"
    assert isinstance(message["at"], int) and message["at"] > 1_700_000_000_000
    assert store.saves == []  # never stored


@pytest.mark.anyio
async def test_chat_needs_the_permission(store):
    room = Room("m", store)
    await room.open()
    v = Peer(conn="v", name="v", role="viewer", perms={"chat": False}, guest=False, user_id=2, guest_key=None)
    other = peer("o")
    await room.join(v, "")
    await room.join(other, "")
    drain(v), drain(other)
    await room.on_text(v, {"type": "chat", "text": "hi"})
    assert texts(v) == [{"type": "error", "code": "no_chat"}]
    assert texts(other) == []


# --- emotes (Task 3.2) -------------------------------------------------------


class Clock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now


async def emote_room(store, monkeypatch, perms=None):
    clock = Clock()
    monkeypatch.setattr("server.rooms.time.monotonic", clock)
    room = Room("m", store)
    await room.open()
    a = Peer(conn="a", name="a", role="editor", perms=perms or {"chat": True}, guest=False, user_id=1, guest_key=None)
    b = peer("b")
    await room.join(a, "")
    await room.join(b, "")
    drain(a), drain(b)
    return room, a, b, clock


def emotes(p):
    return [t for t in texts(p) if t["type"] == "emote"]


@pytest.mark.anyio
async def test_an_emote_reaches_everyone_with_who_sent_it(store, monkeypatch):
    room, a, b, _ = await emote_room(store, monkeypatch)
    await room.on_text(a, {"type": "emote", "id": "wave"})
    assert emotes(b) == [{"type": "emote", "conn": "a", "colour": a.colour, "id": "wave"}]
    assert len(emotes(a)) == 1


@pytest.mark.anyio
async def test_emotes_half_a_second_apart_send_one(store, monkeypatch):
    room, a, b, clock = await emote_room(store, monkeypatch)
    await room.on_text(a, {"type": "emote", "id": "wave"})
    clock.now += 0.5
    await room.on_text(a, {"type": "emote", "id": "heart"})
    assert [e["id"] for e in emotes(b)] == ["wave"]
    assert [t["type"] for t in texts(a)] == ["emote"]  # the wave; the second is dropped without an error


@pytest.mark.anyio
async def test_emotes_more_than_a_second_apart_send_both(store, monkeypatch):
    room, a, b, clock = await emote_room(store, monkeypatch)
    await room.on_text(a, {"type": "emote", "id": "wave"})
    clock.now += 1.1
    await room.on_text(a, {"type": "emote", "id": "heart"})
    assert [e["id"] for e in emotes(b)] == ["wave", "heart"]


@pytest.mark.anyio
@pytest.mark.parametrize("emote_id", ["dance", "", None, 3, "<b>wave</b>"])
async def test_an_unknown_emote_is_ignored(store, monkeypatch, emote_id):
    room, a, b, _ = await emote_room(store, monkeypatch)
    await room.on_text(a, {"type": "emote", "id": emote_id})
    assert texts(b) == [] and texts(a) == []


@pytest.mark.anyio
async def test_an_unknown_emote_does_not_start_the_cooldown(store, monkeypatch):
    room, a, b, _ = await emote_room(store, monkeypatch)
    await room.on_text(a, {"type": "emote", "id": "dance"})
    await room.on_text(a, {"type": "emote", "id": "wave"})
    assert [e["id"] for e in emotes(b)] == ["wave"]


@pytest.mark.anyio
async def test_emotes_need_the_chat_permission(store, monkeypatch):
    room, a, b, _ = await emote_room(store, monkeypatch, perms={"chat": False})
    await room.on_text(a, {"type": "emote", "id": "wave"})
    assert texts(b) == [] and texts(a) == []


def test_the_emote_list_matches_the_clients():
    from pathlib import Path

    from server.rooms import EMOTE_IDS

    source = (Path(__file__).parents[2] / "frontend/src/room/emotes.js").read_text()
    listed = source.split("export const EMOTES = [", 1)[1].split("]", 1)[0]
    assert {part.strip().strip("'\"") for part in listed.split(",") if part.strip()} == EMOTE_IDS


@pytest.mark.anyio
async def test_set_meta_reaches_whoever_joins_next(store):
    registry = RoomRegistry(store)
    registry.bind_loop(asyncio.get_running_loop())
    first = peer("a")
    await registry.join("m", first, "")
    drain(first)
    await asyncio.to_thread(registry.set_meta, "m", name="Renamed", default_look="deep-sea")
    await asyncio.sleep(0.01)
    later = peer("b")
    await registry.join("m", later, "")
    welcome = texts(later)[0]
    assert welcome["map"] == {"id": "m", "name": "Renamed", "default_look": "deep-sea"}
    # Nobody already in is told to switch.
    assert not [t for t in texts(first) if t["type"] not in ("roster",)]


@pytest.mark.anyio
async def test_chat_has_a_budget_per_connection(store, monkeypatch):
    room, a, b, clock = await emote_room(store, monkeypatch)
    for i in range(7):
        await room.on_text(a, {"type": "chat", "text": f"line {i}"})
    got = [t["text"] for t in texts(b) if t["type"] == "chat"]
    assert got == [f"line {i}" for i in range(5)]  # a burst of five, then no more
    errors = [t for t in texts(a) if t["type"] == "error"]
    assert errors == [{"type": "error", "code": "chat_slow"}] * 2  # the sender alone hears why
    clock.now += 1.0  # a second later, one more fits
    await room.on_text(a, {"type": "chat", "text": "again"})
    await room.on_text(a, {"type": "chat", "text": "too soon"})
    assert [t["text"] for t in texts(b) if t["type"] == "chat"] == ["again"]
