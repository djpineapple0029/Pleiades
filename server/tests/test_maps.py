"""A user's maps on the server (server/maps.py)."""

from __future__ import annotations

import pytest

PAYLOAD = {
    "format": "atlasmap",
    "schema": 1,
    "nodes": [{"id": "n1", "label": "root ✦"}, {"id": "n2", "label": ""}],
    "edges": [["n1", "n2"]],
    "from_a_later_build": {"kept": True},
}


CSRF = {"X-Pleiades": "1"}


@pytest.fixture
def alice(accounts_app, signup):
    client = accounts_app.test_client()
    signup(client, "alice")
    return client


@pytest.fixture
def bob(accounts_app, signup):
    client = accounts_app.test_client()
    signup(client, "bob")
    return client


def create(client, name="Galaxy", payload=PAYLOAD):
    response = client.post("/api/maps", json={"name": name, "payload": payload}, headers=CSRF)
    assert response.status_code == 201, response.json
    return response.json["id"]


def save(client, map_id, revision, payload=PAYLOAD):
    return client.put(f"/api/maps/{map_id}", json={"payload": payload}, headers={**CSRF, "If-Match": str(revision)})


def test_round_trip_keeps_unknown_fields(alice):
    map_id = create(alice)
    body = alice.get(f"/api/maps/{map_id}").json
    assert body["payload"] == PAYLOAD
    assert body["name"] == "Galaxy"
    assert body["revision"] == 1

    [listed] = alice.get("/api/maps").json["maps"]
    assert listed["id"] == map_id
    assert listed["node_count"] == 2
    assert listed["size_bytes"] > 0
    assert listed["last_opened_at"] is not None
    assert "payload" not in listed


def test_a_new_map_can_start_empty(alice):
    response = alice.post("/api/maps", json={}, headers=CSRF)
    assert response.json["name"] == "Untitled map"
    assert alice.get(f"/api/maps/{response.json['id']}").json["payload"]["nodes"] == []


def test_save_needs_the_current_revision(alice):
    map_id = create(alice)
    assert alice.put(f"/api/maps/{map_id}", json={"payload": PAYLOAD}, headers=CSRF).status_code == 428
    assert save(alice, map_id, "latest").status_code == 400

    changed = {**PAYLOAD, "nodes": [{"id": "n1"}]}
    ok = save(alice, map_id, 1, changed)
    assert ok.status_code == 200
    assert ok.json["revision"] == 2

    # A second tab still on revision 1 is refused, and told what's current.
    stale = save(alice, map_id, 1)
    assert stale.status_code == 409
    assert stale.json["revision"] == 2
    assert alice.get(f"/api/maps/{map_id}").json["payload"] == changed

    assert save(alice, map_id, '"2"').status_code == 200
    assert alice.get("/api/maps").json["maps"][0]["node_count"] == 2


@pytest.mark.parametrize("payload", [None, [], "text", 5])
def test_payload_must_be_an_object(alice, payload):
    map_id = create(alice)
    assert save(alice, map_id, 1, payload).status_code == 400
    assert alice.post("/api/maps", json={"payload": payload}, headers=CSRF).status_code == 400


def test_nan_is_refused(alice):
    body = '{"payload": {"nodes": [{"x": NaN}]}}'
    response = alice.post("/api/maps", data=body, content_type="application/json", headers=CSRF)
    assert response.status_code == 400


def test_other_users_maps_do_not_exist(alice, bob):
    map_id = create(alice)
    assert bob.get(f"/api/maps/{map_id}").status_code == 404
    assert save(bob, map_id, 1).status_code == 404
    assert bob.patch(f"/api/maps/{map_id}", json={"name": "mine"}, headers=CSRF).status_code == 404
    assert bob.post(f"/api/maps/{map_id}/duplicate", headers=CSRF).status_code == 404
    assert bob.delete(f"/api/maps/{map_id}", headers=CSRF).status_code == 404
    assert bob.get("/api/maps").json["maps"] == []
    assert alice.get(f"/api/maps/{map_id}").json["name"] == "Galaxy"


def test_rename_duplicate_delete(alice):
    map_id = create(alice)
    renamed = alice.patch(f"/api/maps/{map_id}", json={"name": "  Nebula\n "}, headers=CSRF)
    assert renamed.json["name"] == "Nebula"
    assert alice.patch(f"/api/maps/{map_id}", json={"name": "   "}, headers=CSRF).status_code == 400

    copy = alice.post(f"/api/maps/{map_id}/duplicate", headers=CSRF)
    assert copy.status_code == 201
    assert copy.json["name"] == "Nebula (copy)"
    assert alice.get(f"/api/maps/{copy.json['id']}").json["payload"] == PAYLOAD

    assert alice.delete(f"/api/maps/{map_id}", headers=CSRF).status_code == 200
    assert alice.get(f"/api/maps/{map_id}").status_code == 404
    assert [m["id"] for m in alice.get("/api/maps").json["maps"]] == [copy.json["id"]]


def test_names_are_capped(alice):
    map_id = create(alice, "x" * 500)
    name = alice.get(f"/api/maps/{map_id}").json["name"]
    assert name == "x" * 120
    copy = alice.post(f"/api/maps/{map_id}/duplicate", headers=CSRF).json["name"]
    assert len(copy) == 120 and copy.endswith(" (copy)")


def test_quota(accounts_app, alice):
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["accounts"]["max_maps_per_user"] = 2
    assert config.save(values) == []
    first = create(alice)
    create(alice)
    assert alice.post("/api/maps", json={}, headers=CSRF).status_code == 409
    assert alice.post(f"/api/maps/{first}/duplicate", headers=CSRF).status_code == 409


def test_signed_out_is_401(accounts_app, alice):
    map_id = create(alice)
    stranger = accounts_app.test_client()
    assert stranger.get("/api/maps").status_code == 401
    assert stranger.get(f"/api/maps/{map_id}").status_code == 401
    assert save(stranger, map_id, 1).status_code == 401


def test_malformed_ids_are_404(alice):
    assert alice.get("/api/maps/short").status_code == 404
    assert alice.get("/api/maps/" + "a" * 16).status_code == 404


def test_oversized_saves_are_413(accounts_app, alice):
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["server"]["max_upload_mb"] = 1
    assert config.save(values) == []
    map_id = create(alice)
    big = {"nodes": [{"notes": "x" * (2 * 1024 * 1024)}]}
    response = save(alice, map_id, 1, big)
    assert response.status_code == 413
    assert "error" in response.json
