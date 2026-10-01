"""/admin → Accounts (server/admin_users.py) and what a reset leaves an account
able to do (`must_change_password`, server/account.py `/password`)."""

from __future__ import annotations

import pytest

from server import create_app

ACCOUNT_PASSWORD = "long enough pw"  # conftest.py's signup fixture uses the same
ADMIN_PASSWORD = "correct horse"
CSRF = {"X-Pleiades": "1"}


@pytest.fixture
def admin(accounts_app):
    """A client signed in to /admin; its headers carry the bearer token."""
    config = accounts_app.extensions["pleiades_config"]
    config.set_password(config.initial_password, ADMIN_PASSWORD)
    client = accounts_app.test_client()
    token = client.post("/api/admin/login", json={"password": ADMIN_PASSWORD}).json["token"]
    client.environ_base["HTTP_AUTHORIZATION"] = f"Bearer {token}"
    return client


@pytest.fixture
def alice(accounts_app, signup):
    client = accounts_app.test_client()
    signup(client, "alice")
    return client


def users(admin) -> dict:
    response = admin.get("/api/admin/users")
    assert response.status_code == 200, response.json
    return {user["username"]: user for user in response.json["users"]}


def login(client, name="alice", password=ACCOUNT_PASSWORD):
    return client.post("/api/auth/login", json={"username": name, "password": password}, headers=CSRF)


def new_map(client, payload=None):
    body = {"name": "m"} if payload is None else {"name": "m", "payload": payload}
    response = client.post("/api/maps", json=body, headers=CSRF)
    assert response.status_code == 201, response.json
    return response.json["id"]


# --- The door -----------------------------------------------------------------


def test_every_route_needs_the_admin_session(accounts_app, alice):
    anyone = accounts_app.test_client()
    uid = 1
    for method, path in [
        ("get", "/api/admin/users"),
        ("post", f"/api/admin/users/{uid}/password"),
        ("patch", f"/api/admin/users/{uid}"),
        ("post", f"/api/admin/users/{uid}/sign-out"),
        ("delete", f"/api/admin/users/{uid}"),
    ]:
        assert getattr(anyone, method)(path, json={}).status_code == 401, path
        # An account's own session is no key to /admin.
        assert getattr(alice, method)(path, json={}, headers=CSRF).status_code == 401, path


def test_outside_the_allowed_networks_is_a_404(accounts_app, admin):
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["admin"]["allowed_networks"] = ["127.0.0.1/32"]
    assert config.save(values) == []
    outsider = {"REMOTE_ADDR": "10.1.2.3"}
    assert admin.get("/api/admin/users", environ_base={**admin.environ_base, **outsider}).status_code == 404


def test_hardened_like_the_rest_of_admin(admin):
    response = admin.get("/api/admin/users")
    assert response.headers["Cache-Control"] == "no-store"
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]


def test_no_database_is_created_to_list_nobody(isolated_config):
    app = create_app()
    config = app.extensions["pleiades_config"]
    config.set_password(config.initial_password, ADMIN_PASSWORD)
    client = app.test_client()
    token = client.post("/api/admin/login", json={"password": ADMIN_PASSWORD}).json["token"]
    auth = {"Authorization": f"Bearer {token}"}
    listed = client.get("/api/admin/users", headers=auth).json
    assert listed["enabled"] is False
    assert listed["users"] == []
    assert listed["database"]["exists"] is False
    assert client.post("/api/admin/users/1/sign-out", headers=auth).status_code == 404
    status = client.get("/api/admin/status", headers=auth).json
    assert status["accounts"] == {"enabled": False, "database": listed["database"]}
    assert not app.extensions["pleiades_db"].path.exists()


# --- The list -----------------------------------------------------------------


def test_the_list_counts_maps_storage_and_sessions(accounts_app, admin, alice, signup):
    bob = accounts_app.test_client()
    signup(bob, "bob")
    map_id = new_map(alice, {"nodes": [{"id": 1}, {"id": 2}], "edges": []})
    new_map(alice)
    listed = users(admin)
    assert list(listed) == ["alice", "bob"]
    a = listed["alice"]
    assert a["map_count"] == 2
    assert a["map_bytes"] > 0
    assert a["history_bytes"] == 0
    assert a["sessions"] == 1
    assert a["disabled"] is False and a["must_change_password"] is False
    assert a["last_seen_at"] >= a["created_at"]
    assert "password_hash" not in a
    assert listed["bob"]["map_count"] == 0

    # History counts toward the account that owns the map.
    kept = alice.post(f"/api/maps/{map_id}/snapshots", json={"payload": {"nodes": []}, "revision": 1}, headers=CSRF)
    assert kept.status_code == 201, kept.json
    assert users(admin)["alice"]["history_bytes"] > 0


def test_status_reports_the_database(admin, alice):
    new_map(alice)
    database = admin.get("/api/admin/status").json["accounts"]["database"]
    assert database["exists"] is True
    assert (database["users"], database["maps"], database["snapshots"]) == (1, 1, 0)
    assert database["bytes"] > 0


# --- Reset password -------------------------------------------------------------


def test_reset_signs_out_and_hands_back_a_temporary_password(accounts_app, admin, alice):
    uid = users(admin)["alice"]["id"]
    response = admin.post(f"/api/admin/users/{uid}/password")
    assert response.status_code == 200
    temp = response.json["password"]
    assert response.json["username"] == "alice"
    assert len(temp) >= accounts_app.extensions["pleiades_config"].get("accounts", "min_password_length")
    # Every session is gone at once, and the old password stops working.
    assert alice.get("/api/maps").status_code == 401
    assert login(accounts_app.test_client()).status_code == 401
    assert users(admin)["alice"]["must_change_password"] is True

    fresh = accounts_app.test_client()
    signed = login(fresh, password=temp)
    assert signed.status_code == 200
    assert signed.json["user"]["must_change_password"] is True
    assert fresh.get("/api/auth/me").json["user"]["must_change_password"] is True


def test_a_reset_account_can_only_choose_a_new_password(accounts_app, admin, alice):
    map_id = new_map(alice)
    uid = users(admin)["alice"]["id"]
    temp = admin.post(f"/api/admin/users/{uid}/password").json["password"]
    client = accounts_app.test_client()
    login(client, password=temp)

    for method, path in [
        ("get", "/api/maps"),
        ("get", f"/api/maps/{map_id}"),
        ("post", "/api/maps"),
        ("get", "/api/account/settings"),
    ]:
        response = getattr(client, method)(path, json={}, headers=CSRF)
        assert response.status_code == 403, path
        assert response.json["must_change_password"] is True

    # Not the temporary one again, and not too short.
    same = client.post("/api/account/password", json={"new": temp}, headers=CSRF)
    assert same.status_code == 400
    assert client.post("/api/account/password", json={"new": "short"}, headers=CSRF).status_code == 400
    # No current password asked for: this session was opened with the temporary one.
    changed = client.post("/api/account/password", json={"new": "a brand new pw"}, headers=CSRF)
    assert changed.status_code == 200, changed.json
    assert changed.json["user"]["must_change_password"] is False

    assert client.get(f"/api/maps/{map_id}").status_code == 200
    assert users(admin)["alice"]["must_change_password"] is False
    assert login(accounts_app.test_client(), password=temp).status_code == 401
    assert login(accounts_app.test_client(), password="a brand new pw").status_code == 200


def test_a_reset_clears_a_username_lockout(accounts_app, admin, alice):
    stranger = accounts_app.test_client()
    attempts = accounts_app.extensions["pleiades_config"].get("admin", "lockout_attempts")
    for i in range(attempts):
        # A different address each time, so only the per-username counter fills.
        stranger.post(
            "/api/auth/login",
            json={"username": "alice", "password": "nope"},
            headers=CSRF,
            environ_base={"REMOTE_ADDR": f"10.0.0.{i + 1}"},
        )
    assert login(accounts_app.test_client()).status_code == 429
    uid = users(admin)["alice"]["id"]
    temp = admin.post(f"/api/admin/users/{uid}/password").json["password"]
    assert login(accounts_app.test_client(), password=temp).status_code == 200


def test_resetting_nobody_is_a_404(admin, alice):
    assert admin.post("/api/admin/users/999/password").status_code == 404


# --- Changing your own password ---------------------------------------------------


def test_changing_your_password_needs_the_current_one_and_ends_other_sessions(accounts_app, alice):
    other = accounts_app.test_client()
    assert login(other).status_code == 200
    wrong = alice.post("/api/account/password", json={"current": "nope", "new": "another long pw"}, headers=CSRF)
    assert wrong.status_code == 401
    assert alice.post("/api/account/password", json={"new": "another long pw"}, headers=CSRF).status_code == 401
    ok = alice.post("/api/account/password", json={"current": ACCOUNT_PASSWORD, "new": "another long pw"}, headers=CSRF)
    assert ok.status_code == 200, ok.json
    assert alice.get("/api/maps").status_code == 200
    assert other.get("/api/maps").status_code == 401
    assert login(accounts_app.test_client(), password="another long pw").status_code == 200


def test_wrong_current_passwords_lock_out(accounts_app, alice):
    attempts = accounts_app.extensions["pleiades_config"].get("admin", "lockout_attempts")
    for _ in range(attempts):
        alice.post("/api/account/password", json={"current": "nope", "new": "another long pw"}, headers=CSRF)
    locked = alice.post(
        "/api/account/password", json={"current": ACCOUNT_PASSWORD, "new": "another long pw"}, headers=CSRF
    )
    assert locked.status_code == 429


def test_password_change_needs_the_csrf_header(alice):
    response = alice.post("/api/account/password", json={"current": ACCOUNT_PASSWORD, "new": "another long pw"})
    assert response.status_code == 403


# --- Disable, sign out, delete ----------------------------------------------------


def test_disable_signs_out_and_refuses_sign_in_until_enabled(accounts_app, admin, alice):
    map_id = new_map(alice)
    uid = users(admin)["alice"]["id"]
    assert admin.patch(f"/api/admin/users/{uid}", json={"disabled": True}).json == {"ok": True, "disabled": True}
    assert alice.get("/api/maps").status_code == 401
    assert login(accounts_app.test_client()).status_code == 401
    listed = users(admin)["alice"]
    assert listed["disabled"] is True and listed["sessions"] == 0 and listed["map_count"] == 1

    assert admin.patch(f"/api/admin/users/{uid}", json={"disabled": False}).status_code == 200
    back = accounts_app.test_client()
    assert login(back).status_code == 200
    assert back.get(f"/api/maps/{map_id}").status_code == 200


def test_disable_wants_a_boolean(admin, alice):
    uid = users(admin)["alice"]["id"]
    assert admin.patch(f"/api/admin/users/{uid}", json={"disabled": "yes"}).status_code == 400
    assert admin.patch(f"/api/admin/users/{uid}", json={}).status_code == 400


def test_sign_out_everywhere(accounts_app, admin, alice):
    other = accounts_app.test_client()
    login(other)
    uid = users(admin)["alice"]["id"]
    assert users(admin)["alice"]["sessions"] == 2
    assert admin.post(f"/api/admin/users/{uid}/sign-out").json == {"ok": True, "ended": 2}
    assert alice.get("/api/maps").status_code == 401
    assert other.get("/api/maps").status_code == 401
    # Not disabled: signing in again works.
    assert login(accounts_app.test_client()).status_code == 200


def test_delete_needs_the_username_typed_and_takes_everything_with_it(accounts_app, admin, alice, signup):
    bob = accounts_app.test_client()
    signup(bob, "bob")
    bob_map = new_map(bob)
    map_id = new_map(alice)
    alice.post(f"/api/maps/{map_id}/snapshots", json={"payload": {"nodes": []}, "revision": 1}, headers=CSRF)
    alice.patch("/api/account/settings", json={"flight": {"move_speed": 20}}, headers=CSRF)
    uid = users(admin)["alice"]["id"]

    assert admin.delete(f"/api/admin/users/{uid}").status_code == 400
    assert admin.delete(f"/api/admin/users/{uid}", json={"username": "bob"}).status_code == 400
    assert "alice" in users(admin)

    assert admin.delete(f"/api/admin/users/{uid}", json={"username": " Alice "}).json == {"ok": True}
    assert "alice" not in users(admin)
    assert alice.get("/api/maps").status_code == 401
    assert login(accounts_app.test_client()).status_code == 401
    with accounts_app.extensions["pleiades_db"].connect() as conn:
        for table in ("maps", "sessions", "user_settings"):
            (count,) = conn.execute(f"SELECT COUNT(*) FROM {table} WHERE user_id = ?", (uid,)).fetchone()  # noqa: S608
            assert count == 0, table
        (snapshots,) = conn.execute("SELECT COUNT(*) FROM snapshots").fetchone()
        assert snapshots == 0
    # Someone else's things are untouched.
    assert bob.get(f"/api/maps/{bob_map}").status_code == 200
    assert admin.delete(f"/api/admin/users/{uid}", json={"username": "alice"}).status_code == 404


def test_the_name_is_free_again_after_delete(accounts_app, admin, alice, signup):
    uid = users(admin)["alice"]["id"]
    admin.delete(f"/api/admin/users/{uid}", json={"username": "alice"})
    signup(accounts_app.test_client(), "alice")
    assert users(admin)["alice"]["map_count"] == 0


def test_actions_work_with_accounts_switched_off(accounts_app, admin, alice):
    config = accounts_app.extensions["pleiades_config"]
    values = config.all_values()
    values["accounts"]["enabled"] = False
    assert config.save(values) == []
    listed = admin.get("/api/admin/users").json
    assert listed["enabled"] is False
    uid = listed["users"][0]["id"]
    assert admin.post(f"/api/admin/users/{uid}/sign-out").status_code == 200
    assert admin.delete(f"/api/admin/users/{uid}", json={"username": "alice"}).status_code == 200
