"""The live-map WebSocket (server/ws.py) through the real ASGI app."""

from __future__ import annotations

import json

import pytest
from pycrdt import Doc, Map, Text, create_sync_message, create_update_message, handle_sync_message

CSRF = {"X-Pleiades": "1"}
ORIGIN = {"origin": "http://testserver"}


def sign_up(client, name):
    """Signs `name` up; the client is now them. Returns their session token, for
    `be(client, token)`: one TestClient (one event loop, like uvicorn's) plays
    several people by swapping cookies."""
    client.cookies.clear()
    r = client.post("/api/auth/signup", json={"username": name, "password": "long enough pw"}, headers=CSRF)
    assert r.status_code == 201
    return client.cookies.get("atlas_session")


def be(client, token):
    client.cookies.clear()
    client.cookies.set("atlas_session", token)


def new_map(client):
    return client.post("/api/maps", json={"name": "G"}, headers=CSRF).json()["id"]


def first_texts(ws, n):
    out = []
    while len(out) < n:
        message = ws.receive()
        if message.get("text"):
            out.append(json.loads(message["text"]))
    return out


def wait_for_close(ws):
    """The server's close code. Starlette's TestClient hands a close over as a
    message rather than raising, so this reads until one arrives."""
    while True:
        message = ws.receive()
        if message["type"] == "websocket.close":
            return message["code"]


def closed_code(world, map_id, headers=ORIGIN):
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=headers) as ws:
        return wait_for_close(ws)


def handshake(ws):
    """Welcome, then the sync handshake as roomClient.js does it; returns the client doc."""
    client = Doc()
    first_texts(ws, 1)
    message = ws.receive()  # server step1
    ws.send_bytes(handle_sync_message(message["bytes"][1:], client))
    ws.send_bytes(create_sync_message(client))
    while True:
        message = ws.receive()
        if message.get("bytes"):
            handle_sync_message(message["bytes"][1:], client)
            return client


def test_owner_connects_and_gets_welcome(world):
    sign_up(world, "alice")
    map_id = new_map(world)
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
        welcome = first_texts(ws, 1)[0]
        assert welcome["type"] == "welcome" and welcome["you"]["role"] == "owner" and welcome["you"]["name"] == "alice"


def test_foreign_origin_is_refused(world):
    sign_up(world, "alice")
    assert closed_code(world, new_map(world), {"origin": "https://evil.example"}) == 4403


def test_no_session_no_access(world):
    sign_up(world, "alice")
    map_id = new_map(world)
    world.cookies.clear()
    assert closed_code(world, map_id) == 4404


def test_a_stranger_gets_404(world):
    sign_up(world, "alice")
    map_id = new_map(world)
    sign_up(world, "mallory")
    assert closed_code(world, map_id) == 4404


def test_a_bad_map_id_is_404(world):
    sign_up(world, "alice")
    assert closed_code(world, "not-a-real-id") == 4404


def test_oversized_frame_is_closed(world):
    sign_up(world, "alice")
    map_id = new_map(world)
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
        first_texts(ws, 1)
        ws.send_bytes(b"\x00\x02" + b"x" * (2 * 1024 * 1024 + 1))
        assert wait_for_close(ws) == 4413


def test_an_edit_is_saved_as_the_payload(world):
    sign_up(world, "alice")
    map_id = new_map(world)
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
        client = handshake(ws)
        updates = []
        client.observe(lambda e: updates.append(e.update))
        with client.transaction():
            node = Map()
            client.get("nodes", type=Map)["n-1"] = node
            for k, v in {"id": "n-1", "label": "Hi", "x": 0.0, "y": 0.0, "z": 0.0}.items():
                node[k] = v
            node["notes"] = Text("")  # a star's notes are shared text, or the room refuses it
        ws.send_bytes(create_update_message(updates[-1]))
    # Leaving persists at once (last person out).
    download = world.get(f"/api/maps/{map_id}").json()
    assert [n["label"] for n in download["payload"]["nodes"]] == ["Hi"]


def test_a_member_joins_and_is_marked_as_having_seen_the_map(world):
    bob = sign_up(world, "bobby")
    sign_up(world, "alice")
    map_id = new_map(world)
    world.post(f"/api/maps/{map_id}/members", json={"username": "bobby", "role": "viewer"}, headers=CSRF)
    be(world, bob)
    assert world.get("/api/maps/shared").json()["maps"][0]["new"] is True
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
        assert first_texts(ws, 1)[0]["you"]["role"] == "viewer"
    assert world.get("/api/maps/shared").json()["maps"][0]["new"] is False


def test_a_viewers_edit_is_refused_as_read_only(world):
    bob = sign_up(world, "bobby")
    sign_up(world, "alice")
    map_id = new_map(world)
    world.post(f"/api/maps/{map_id}/members", json={"username": "bobby", "role": "viewer"}, headers=CSRF)
    be(world, bob)
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
        client = handshake(ws)
        updates = []
        client.observe(lambda e: updates.append(e.update))
        client.get("meta", type=Map)["camera"] = "hacked"
        ws.send_bytes(create_update_message(updates[-1]))
        while True:
            message = ws.receive()
            if message.get("text") and json.loads(message["text"])["type"] == "read_only":
                break


def test_two_people_see_each_other_in_the_roster(world):
    bob = sign_up(world, "bobby")
    alice = sign_up(world, "alice")
    map_id = new_map(world)
    world.post(f"/api/maps/{map_id}/members", json={"username": "bobby", "role": "editor"}, headers=CSRF)
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as a:
        first_texts(a, 1)
        be(world, bob)
        with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as b:
            first_texts(b, 1)
            while True:
                roster = first_texts(a, 1)[0]
                if roster["type"] == "roster" and len(roster["people"]) == 2:
                    break
            assert sorted(p["name"] for p in roster["people"]) == ["alice", "bobby"]
    be(world, alice)


def test_a_reset_password_account_is_refused(world, asgi):
    sign_up(world, "alice")
    map_id = new_map(world)
    with asgi.state.flask.extensions["pleiades_db"].connect() as conn:
        conn.execute("UPDATE users SET must_change_password = 1")
    assert closed_code(world, map_id) == 4404


def test_a_removed_member_is_sent_out_of_the_open_map(world):
    bob = sign_up(world, "bobby")
    alice = sign_up(world, "alice")
    map_id = new_map(world)
    world.post(f"/api/maps/{map_id}/members", json={"username": "bobby", "role": "editor"}, headers=CSRF)
    be(world, bob)
    bob_id = world.get("/api/auth/me").json()["user"]["id"]
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
        first_texts(ws, 1)
        be(world, alice)
        assert world.delete(f"/api/maps/{map_id}/members/{bob_id}", headers=CSRF).status_code == 200
        assert wait_for_close(ws) == 4403


# --- Milestone 2: guests on a share link ------------------------------------

GUEST_KEY = "g" * 22


def guest_link(world, role="viewer"):
    """Signs alice up, makes a map and a link to it; returns (map id, token).
    The client is signed out afterwards."""
    sign_up(world, "alice")
    map_id = new_map(world)
    url = world.post(f"/api/maps/{map_id}/link", json={"role": role}, headers=CSRF).json()["url"]
    world.cookies.clear()
    return map_id, url.rsplit("/s/", 1)[1]


def guest_url(map_id, token, name="Ari", key=GUEST_KEY):
    from urllib.parse import urlencode

    return f"/ws/maps/{map_id}?{urlencode({'link': token, 'name': name, 'guest': key})}"


def test_a_guest_joins_by_link_with_a_name(world):
    map_id, token = guest_link(world)
    with world.websocket_connect(guest_url(map_id, token, name="  Ari "), headers=ORIGIN) as ws:
        you = first_texts(ws, 1)[0]["you"]
        assert you["role"] == "viewer" and you["guest"] is True and you["name"] == "Ari"
        assert you["user_id"] is None


def test_a_guest_on_an_edit_link_can_edit(world):
    map_id, token = guest_link(world, role="editor")
    with world.websocket_connect(guest_url(map_id, token), headers=ORIGIN) as ws:
        assert first_texts(ws, 1)[0]["you"]["role"] == "editor"


@pytest.mark.parametrize(("name", "key"), [("", GUEST_KEY), ("‮", GUEST_KEY), ("Ari", "short"), ("Ari", "!" * 22)])
def test_a_bad_guest_name_or_key_is_closed_4400(world, name, key):
    map_id, token = guest_link(world)
    with world.websocket_connect(guest_url(map_id, token, name=name, key=key), headers=ORIGIN) as ws:
        assert wait_for_close(ws) == 4400


def test_a_revoked_link_lets_no_guest_in(world):
    map_id, token = guest_link(world)
    with world.websocket_connect(guest_url(map_id, "x" + token), headers=ORIGIN) as ws:
        assert wait_for_close(ws) == 4404


def test_revoking_the_link_sends_a_connected_guest_out(world):
    sign_up(world, "alice")
    alice = world.cookies.get("atlas_session")
    map_id = new_map(world)
    token = world.post(f"/api/maps/{map_id}/link", json={"role": "viewer"}, headers=CSRF).json()["url"].rsplit("/s/")[1]
    world.cookies.clear()
    with world.websocket_connect(guest_url(map_id, token), headers=ORIGIN) as ws:
        first_texts(ws, 1)
        be(world, alice)
        assert world.delete(f"/api/maps/{map_id}/link", headers=CSRF).status_code == 200
        assert wait_for_close(ws) == 4403


# --- Milestone 2: accounts that go away -------------------------------------


def test_deleting_an_account_closes_its_maps_for_everyone_in_them(world):
    bob = sign_up(world, "bobby")
    alice = sign_up(world, "alice")
    map_id = new_map(world)
    world.post(f"/api/maps/{map_id}/members", json={"username": "bobby", "role": "editor"}, headers=CSRF)
    be(world, bob)
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
        first_texts(ws, 1)
        be(world, alice)
        r = world.request("DELETE", "/api/account", json={"password": "long enough pw"}, headers=CSRF)
        assert r.status_code == 200
        texts = []
        while True:
            message = ws.receive()
            if message["type"] == "websocket.close":
                break
            if message.get("text"):
                texts.append(json.loads(message["text"])["type"])
        assert "deleted" in texts and message["code"] == 4404


def test_a_member_whose_account_is_deleted_leaves_the_room(world):
    bob = sign_up(world, "bobby")
    alice = sign_up(world, "alice")
    map_id = new_map(world)
    world.post(f"/api/maps/{map_id}/members", json={"username": "bobby", "role": "editor"}, headers=CSRF)
    be(world, alice)
    with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as owner_ws:
        first_texts(owner_ws, 1)
        be(world, bob)
        with world.websocket_connect(f"/ws/maps/{map_id}", headers=ORIGIN) as ws:
            first_texts(ws, 1)
            r = world.request("DELETE", "/api/account", json={"password": "long enough pw"}, headers=CSRF)
            assert r.status_code == 200
            assert wait_for_close(ws) == 4403
