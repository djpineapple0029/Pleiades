"""The admin's sharing switches (context/MOONSHOT.md decision 23) take
effect at once, on people already in a map too."""

from __future__ import annotations

import pytest
from starlette.testclient import TestClient

from server.tests.test_ws import ORIGIN, be, first_texts, guest_url, new_map, sign_up, wait_for_close

CSRF = {"X-Pleiades": "1"}
ADMIN_PASSWORD = "correct horse"


@pytest.fixture
def lan(asgi):
    """The ASGI app from a LAN address, so /admin answers (and, not being
    loopback, session cookies aren't marked Secure over http)."""
    config = asgi.state.flask.extensions["pleiades_config"]
    config.set_password(config.initial_password, ADMIN_PASSWORD)
    with TestClient(asgi, base_url="http://testserver", client=("192.168.1.20", 50000)) as client:
        yield client


def admin_put(client, **sharing):
    """The panel's save: every value, with these sharing ones changed."""
    auth = {
        "Authorization": f"Bearer {client.post('/api/admin/login', json={'password': ADMIN_PASSWORD}).json()['token']}"
    }
    values = client.get("/api/admin/config", headers=auth).json()["values"]
    values["sharing"].update(sharing)
    return client.put("/api/admin/config", json=values, headers=auth)


def admin_save(client, **sharing):
    r = admin_put(client, **sharing)
    assert r.status_code == 200, r.json()


@pytest.fixture
def shared(lan):
    eddie = sign_up(lan, "eddie")
    alice = sign_up(lan, "alice")
    map_id = new_map(lan)
    lan.post(f"/api/maps/{map_id}/members", json={"username": "eddie", "role": "editor"}, headers=CSRF)
    token = lan.post(f"/api/maps/{map_id}/link", json={"role": "viewer"}, headers=CSRF).json()["url"].split("/s/")[1]
    return {"alice": alice, "eddie": eddie, "map": map_id, "token": token}


def test_sharing_off_sends_everyone_but_the_owner_out(lan, shared):
    be(lan, shared["eddie"])
    with lan.websocket_connect(f"/ws/maps/{shared['map']}", headers=ORIGIN) as ws:
        first_texts(ws, 1)
        admin_save(lan, enabled=False)
        assert wait_for_close(ws) == 4403
    assert lan.get(f"/api/maps/{shared['map']}/sharing").status_code == 404
    be(lan, shared["alice"])
    with lan.websocket_connect(f"/ws/maps/{shared['map']}", headers=ORIGIN) as ws:
        assert first_texts(ws, 1)[0]["you"]["role"] == "owner"


def test_guest_links_off_sends_guests_out_and_the_link_page_is_gone(lan, shared):
    lan.cookies.clear()
    with lan.websocket_connect(guest_url(shared["map"], shared["token"]), headers=ORIGIN) as ws:
        first_texts(ws, 1)
        admin_save(lan, guest_links=False)
        assert wait_for_close(ws) == 4403
    lan.cookies.clear()
    assert lan.get(f"/s/{shared['token']}", follow_redirects=False).status_code == 410
    # Signed-in people may still use the link: it makes them members.
    be(lan, shared["eddie"])
    assert lan.get(f"/s/{shared['token']}", follow_redirects=False).status_code == 302


def test_max_people_applies_to_the_next_join(lan, shared):
    admin_save(lan, max_people_per_map=2)
    carol = sign_up(lan, "carol")
    be(lan, shared["alice"])
    lan.post(f"/api/maps/{shared['map']}/members", json={"username": "carol", "role": "viewer"}, headers=CSRF)
    with lan.websocket_connect(f"/ws/maps/{shared['map']}", headers=ORIGIN) as one:
        first_texts(one, 1)
        be(lan, shared["eddie"])
        with lan.websocket_connect(f"/ws/maps/{shared['map']}", headers=ORIGIN) as two:
            first_texts(two, 1)
            be(lan, carol)
            with lan.websocket_connect(f"/ws/maps/{shared['map']}", headers=ORIGIN) as three:
                assert wait_for_close(three) == 4429


def test_max_people_is_at_least_two(lan):
    assert admin_put(lan, max_people_per_map=1).status_code == 400
    assert admin_put(lan, max_people_per_map=2).status_code == 200
