"""Milestone 7: uploading a map file, the zip of everything, and an account's
self-service (server/account.py, server/maps.py `/import`)."""

from __future__ import annotations

import io
import json
import zipfile

import pytest

from server.atlasfile import decode_any, encode, encode_v2

ACCOUNT_PASSWORD = "long enough pw"  # conftest.py's signup fixture uses the same
CSRF = {"X-Pleiades": "1"}
PAYLOAD = {
    "format": "atlasmap",
    "schema": 1,
    "nodes": [{"id": "a", "label": "Star", "x": 1.0, "y": 2.0, "z": 3.0}],
    "edges": [],
    "future_field": {"kept": True},
}


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


def login(client, name="alice", password=ACCOUNT_PASSWORD):
    return client.post("/api/auth/login", json={"username": name, "password": password}, headers=CSRF)


def new_map(client, name="m", payload=None):
    response = client.post("/api/maps", json={"name": name, "payload": payload or PAYLOAD}, headers=CSRF)
    assert response.status_code == 201, response.json
    return response.json["id"]


def upload(client, blob, filename="Trip.plm", password="", headers=CSRF, **fields):
    data = {"file": (io.BytesIO(blob), filename), "password": password, **fields}
    return client.post("/api/maps/import", data=data, headers=headers, content_type="multipart/form-data")


# --- Upload ---------------------------------------------------------------------


def test_upload_an_encrypted_file_named_after_the_file(alice):
    response = upload(alice, encode_v2(PAYLOAD, "secret"), password="secret")
    assert response.status_code == 201, response.json
    assert response.json["name"] == "Trip"
    opened = alice.get(f"/api/maps/{response.json['id']}").json
    assert opened["payload"] == PAYLOAD  # unknown fields pass through
    assert alice.get("/api/maps").json["maps"][0]["node_count"] == 1


def test_upload_reads_v1_and_unencrypted_legacy_files(alice):
    assert upload(alice, encode(PAYLOAD, "pw"), filename="old.atlasmap", password="pw").json["name"] == "old"
    plain = upload(alice, encode_v2(PAYLOAD, ""), filename="plain.atlasmap")
    assert plain.status_code == 201
    assert plain.json["name"] == "plain"


def test_upload_takes_a_name_given_with_it(alice):
    assert upload(alice, encode_v2(PAYLOAD, ""), name="  Chosen  ").json["name"] == "Chosen"


def test_upload_wrong_password_is_401_not_a_lost_session(alice):
    response = upload(alice, encode_v2(PAYLOAD, "secret"), password="nope")
    assert response.status_code == 401
    assert "password" in response.json["error"].lower()
    assert response.json["wrong_password"] is True
    assert alice.get("/api/maps").status_code == 200


@pytest.mark.parametrize(
    "blob",
    [
        b"not a map at all",
        encode_v2({"format": "something-else", "nodes": []}, ""),
        encode_v2({"nodes": "nope"}, ""),
    ],
)
def test_upload_refuses_what_is_not_a_map(alice, blob):
    assert upload(alice, blob).status_code == 400
    assert alice.get("/api/maps").json["maps"] == []


def test_upload_needs_a_file_session_and_csrf(accounts_app, alice):
    assert alice.post("/api/maps/import", data={}, headers=CSRF).status_code == 400
    assert upload(alice, encode_v2(PAYLOAD, ""), headers={}).status_code == 403
    assert upload(accounts_app.test_client(), encode_v2(PAYLOAD, "")).status_code == 401


def test_upload_respects_the_quota(accounts_app, alice):
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["accounts"]["max_maps_per_user"] = 1
    assert config.save(values) == []
    new_map(alice)
    assert upload(alice, encode_v2(PAYLOAD, "")).status_code == 409


# --- Download all my data ---------------------------------------------------------


def read_zip(response) -> zipfile.ZipFile:
    assert response.status_code == 200, response.data[:200]
    assert response.mimetype == "application/zip"
    return zipfile.ZipFile(io.BytesIO(response.data))


def test_export_zip_holds_every_map_as_an_open_file_plus_a_manifest(alice, bob):
    first = new_map(alice, "Trip")
    new_map(alice, "trip")  # same name, other case: numbered, not overwritten
    new_map(alice, "a/b:c")
    new_map(bob, "Bob's")
    assert alice.patch("/api/account/settings", json={"flight": {"invert_y": True}}, headers=CSRF).status_code == 200

    response = alice.get("/api/account/export.zip")
    assert "pleiades-alice-" in response.headers["Content-Disposition"]
    assert response.headers["Cache-Control"] == "no-store"
    archive = read_zip(response)
    names = sorted(archive.namelist())
    assert names == ["README.txt", "manifest.json", "maps/Trip.plm", "maps/a-bc.plm", "maps/trip (2).plm"]

    manifest = json.loads(archive.read("manifest.json"))
    assert manifest["format"] == "pleiades-account-export"
    assert manifest["username"] == "alice"
    assert manifest["settings"] == {"flight": {"invert_y": True}}
    by_file = {entry["file"]: entry for entry in manifest["maps"]}
    assert by_file["maps/Trip.plm"]["id"] == first
    assert by_file["maps/trip (2).plm"]["name"] == "trip"
    for path in by_file:
        # No password: the zip is the copy, readable anywhere.
        assert decode_any(archive.read(path), "") == PAYLOAD


def test_export_zip_with_no_maps(alice):
    manifest = json.loads(read_zip(alice.get("/api/account/export.zip")).read("manifest.json"))
    assert manifest["maps"] == []


def test_export_zip_needs_a_session(accounts_app):
    assert accounts_app.test_client().get("/api/account/export.zip").status_code == 401


# --- Account summary --------------------------------------------------------------


def test_summary_counts_other_sessions_and_storage(accounts_app, alice):
    new_map(alice)
    assert login(accounts_app.test_client()).status_code == 200
    summary = alice.get("/api/account").json
    assert summary["username"] == "alice"
    assert summary["other_sessions"] == 1
    assert summary["maps"] == 1
    assert summary["map_bytes"] > 0


# --- Sign out other devices ---------------------------------------------------------


def test_sign_out_others_keeps_this_session(accounts_app, alice, bob):
    others = [accounts_app.test_client() for _ in range(2)]
    for other in others:
        assert login(other).status_code == 200
    response = alice.post("/api/account/sessions/revoke-others", headers=CSRF)
    assert response.json == {"ended": 2}
    assert alice.get("/api/maps").status_code == 200
    assert all(other.get("/api/maps").status_code == 401 for other in others)
    assert bob.get("/api/maps").status_code == 200  # someone else's sessions are theirs
    assert alice.post("/api/account/sessions/revoke-others").status_code == 403  # CSRF


# --- Change username -----------------------------------------------------------------


def test_change_username_needs_the_password_and_keeps_everything(accounts_app, alice):
    map_id = new_map(alice)
    other = accounts_app.test_client()
    assert login(other).status_code == 200

    wrong = alice.post("/api/account/username", json={"username": "alicia", "password": "nope"}, headers=CSRF)
    assert wrong.status_code == 401
    assert wrong.json["wrong_password"] is True

    ok = alice.post("/api/account/username", json={"username": "  Alicia ", "password": ACCOUNT_PASSWORD}, headers=CSRF)
    assert ok.status_code == 200, ok.json
    assert ok.json["user"]["username"] == "alicia"
    assert alice.get("/api/auth/me").json["user"]["username"] == "alicia"
    assert other.get(f"/api/maps/{map_id}").status_code == 200  # sessions stay
    assert login(accounts_app.test_client(), "alice").status_code == 401
    assert login(accounts_app.test_client(), "alicia").status_code == 200


def test_change_username_refusals(alice, bob):
    def change(name, password=ACCOUNT_PASSWORD):
        return alice.post("/api/account/username", json={"username": name, "password": password}, headers=CSRF)

    assert change("bob").status_code == 409
    assert change("alice").status_code == 400
    assert change("no spaces").status_code == 400
    assert change("x").status_code == 400
    assert alice.post("/api/account/username", json={"username": "fine"}).status_code == 403  # CSRF


def test_wrong_passwords_lock_out_the_username_change(accounts_app, alice):
    attempts = accounts_app.extensions["pleiades_config"].get("admin", "lockout_attempts")
    for _ in range(attempts):
        alice.post("/api/account/username", json={"username": "alicia", "password": "nope"}, headers=CSRF)
    locked = alice.post(
        "/api/account/username", json={"username": "alicia", "password": ACCOUNT_PASSWORD}, headers=CSRF
    )
    assert locked.status_code == 429


def test_wrong_current_password_says_so(alice):
    response = alice.post("/api/account/password", json={"current": "nope", "new": "another long pw"}, headers=CSRF)
    assert response.status_code == 401
    assert response.json["wrong_password"] is True


# --- Delete account ------------------------------------------------------------------


def test_delete_account_needs_the_password_then_takes_everything(accounts_app, alice, bob, signup):
    map_id = new_map(alice)
    alice.post(f"/api/maps/{map_id}/snapshots", json={"payload": PAYLOAD}, headers=CSRF)
    alice.patch("/api/account/settings", json={"flight": {"invert_y": True}}, headers=CSRF)
    other = accounts_app.test_client()
    assert login(other).status_code == 200
    bobs = new_map(bob)

    wrong = alice.delete("/api/account", json={"password": "nope"}, headers=CSRF)
    assert wrong.status_code == 401
    assert wrong.json["wrong_password"] is True
    assert alice.delete("/api/account", json={"password": ACCOUNT_PASSWORD}).status_code == 403  # CSRF

    response = alice.delete("/api/account", json={"password": ACCOUNT_PASSWORD}, headers=CSRF)
    assert response.status_code == 200, response.json
    assert "atlas_session=;" in response.headers["Set-Cookie"]
    assert other.get("/api/maps").status_code == 401
    assert login(accounts_app.test_client()).status_code == 401

    database = accounts_app.extensions["pleiades_db"]
    with database.connect() as conn:
        for table in ("maps", "snapshots", "user_settings", "sessions"):
            rows = conn.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]  # noqa: S608 -- fixed names
            # Only bob's things are left: his map and his one session.
            assert rows == {"maps": 1, "snapshots": 0, "user_settings": 0, "sessions": 1}[table], table
    assert bob.get(f"/api/maps/{bobs}").status_code == 200

    # The name is free again.
    signup(accounts_app.test_client(), "alice")


def test_self_service_waits_for_a_new_password_after_a_reset(accounts_app, alice):
    database = accounts_app.extensions["pleiades_db"]
    with database.connect() as conn:
        conn.execute("UPDATE users SET must_change_password = 1")
    for method, path, body in [
        ("get", "/api/account", None),
        ("get", "/api/account/export.zip", None),
        ("post", "/api/account/username", {"username": "x2x", "password": ACCOUNT_PASSWORD}),
        ("post", "/api/account/sessions/revoke-others", None),
        ("delete", "/api/account", {"password": ACCOUNT_PASSWORD}),
    ]:
        response = getattr(alice, method)(path, json=body, headers=CSRF)
        assert response.status_code == 403, path
        assert response.json["must_change_password"] is True
    assert upload(alice, encode_v2(PAYLOAD, "")).status_code == 403


def test_everything_404s_with_accounts_off(accounts_app, alice):
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["accounts"]["enabled"] = False
    assert config.save(values) == []
    assert alice.get("/api/account").status_code == 404
    assert alice.get("/api/account/export.zip").status_code == 404
    assert upload(alice, encode_v2(PAYLOAD, "")).status_code == 404
