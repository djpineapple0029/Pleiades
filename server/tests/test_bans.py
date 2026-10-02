"""Kick, ban and unban (server/sharing.py, server/rooms.py, server/access.py),
through the real ASGI app like test_ws.py."""

from __future__ import annotations

import json

import pytest

from server.tests.test_ws import ORIGIN, be, first_texts, guest_url, new_map, sign_up, wait_for_close

CSRF = {"X-Pleiades": "1"}


@pytest.fixture
def party(world):
    """alice owns a map shared with bobby (editor). Returns tokens and ids."""
    bob = sign_up(world, "bobby")
    bob_id = world.get("/api/auth/me").json()["user"]["id"]
    alice = sign_up(world, "alice")
    map_id = new_map(world)
    world.post(f"/api/maps/{map_id}/members", json={"username": "bobby", "role": "editor"}, headers=CSRF)
    return {"alice": alice, "bob": bob, "bob_id": bob_id, "map": map_id}


def kick(world, party, conn, ban=False):
    be(world, party["alice"])
    return world.post(f"/api/maps/{party['map']}/kick", json={"conn": conn, "ban": ban}, headers=CSRF)


def test_owner_kicks_a_connected_editor(world, party):
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        assert kick(world, party, conn).status_code == 200
        messages = []
        while True:
            message = ws.receive()
            if message["type"] == "websocket.close":
                code = message["code"]
                break
            if message.get("text"):
                messages.append(json.loads(message["text"]))
        assert {"type": "kicked", "reason": "kicked"} in messages and code == 4403
    # A kick without a ban: still a member, so they can come back.
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        assert first_texts(ws, 1)[0]["type"] == "welcome"


def test_kick_and_ban_keeps_them_out_until_unbanned(world, party):
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        assert kick(world, party, conn, ban=True).status_code == 200
        assert wait_for_close(ws) == 4403
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        assert wait_for_close(ws) == 4404
    assert world.get("/api/maps/shared").json()["maps"] == []

    be(world, party["alice"])
    bans = world.get(f"/api/maps/{party['map']}/sharing").json()["bans"]
    assert [(b["name"], b["guest"]) for b in bans] == [("bobby", False)]
    assert world.delete(f"/api/maps/{party['map']}/bans/{bans[0]['id']}", headers=CSRF).status_code == 200
    assert world.get(f"/api/maps/{party['map']}/sharing").json()["bans"] == []
    added = world.post(f"/api/maps/{party['map']}/members", json={"username": "bobby", "role": "viewer"}, headers=CSRF)
    assert added.status_code == 201
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        assert first_texts(ws, 1)[0]["you"]["role"] == "viewer"


def test_a_banned_member_cannot_come_back_by_link(world, party):
    be(world, party["alice"])
    token = world.post(f"/api/maps/{party['map']}/link", json={"role": "editor"}, headers=CSRF).json()["url"]
    token = token.rsplit("/s/", 1)[1]
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        kick(world, party, conn, ban=True)
        wait_for_close(ws)
    be(world, party["bob"])
    assert world.post(f"/api/maps/{party['map']}/join", json={"link": token}, headers=CSRF).status_code == 404


def test_an_editor_cannot_add_back_someone_the_owner_banned(world, party):
    carol = sign_up(world, "carol")
    be(world, party["alice"])
    world.post(f"/api/maps/{party['map']}/members", json={"username": "carol", "role": "editor"}, headers=CSRF)
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        kick(world, party, conn, ban=True)
        wait_for_close(ws)
    be(world, carol)
    again = world.post(f"/api/maps/{party['map']}/members", json={"username": "bobby", "role": "viewer"}, headers=CSRF)
    assert again.status_code == 409


def test_a_guest_ban_holds_for_that_tab_only(world, party):
    """Documented limitation (Help page): a guest ban is tied to the tab's
    guest key; a new tab gets a new key while the link works."""
    be(world, party["alice"])
    token = world.post(f"/api/maps/{party['map']}/link", json={"role": "viewer"}, headers=CSRF).json()["url"]
    token = token.rsplit("/s/", 1)[1]
    world.cookies.clear()
    with world.websocket_connect(guest_url(party["map"], token, key="a" * 22), headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        assert kick(world, party, conn, ban=True).status_code == 200
        assert wait_for_close(ws) == 4403
    bans = world.get(f"/api/maps/{party['map']}/sharing").json()["bans"]
    assert [(b["name"], b["guest"]) for b in bans] == [("Ari", True)]
    world.cookies.clear()
    with world.websocket_connect(guest_url(party["map"], token, key="a" * 22), headers=ORIGIN) as ws:
        assert wait_for_close(ws) == 4404
    with world.websocket_connect(guest_url(party["map"], token, key="b" * 22), headers=ORIGIN) as ws:
        assert first_texts(ws, 1)[0]["type"] == "welcome"


def test_only_the_owner_kicks(world, party):
    be(world, party["alice"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        be(world, party["bob"])
        assert world.post(f"/api/maps/{party['map']}/kick", json={"conn": conn}, headers=CSRF).status_code == 403


def test_kicking_someone_not_in_the_room_is_404_and_the_owner_cannot_be_kicked(world, party):
    assert kick(world, party, "nobody").status_code == 404
    be(world, party["alice"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        assert kick(world, party, conn).status_code == 400


def test_the_owner_sees_who_is_in_the_map(world, party):
    be(world, party["bob"])
    with world.websocket_connect(f"/ws/maps/{party['map']}", headers=ORIGIN) as ws:
        conn = first_texts(ws, 1)[0]["you"]["conn"]
        be(world, party["alice"])
        online = world.get(f"/api/maps/{party['map']}/sharing").json()["online"]
        assert [(p["conn"], p["name"], p["role"], p["guest"]) for p in online] == [(conn, "bobby", "editor", False)]
