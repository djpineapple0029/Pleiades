"""A signed-in user's own settings layered over the admin's (server/account.py, `/api/config`)."""

from __future__ import annotations

import pytest

from server.config import SCHEMA, SETTINGS, apply_overrides, default_keybinds, validate_overrides

CSRF = {"X-Atlas": "1"}


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


def put(client, body):
    return client.put("/api/account/settings", json=body, headers=CSRF)


def patch(client, body):
    return client.patch("/api/account/settings", json=body, headers=CSRF)


def admin_save(app, change):
    config = app.extensions["atlasmap_config"]
    values = config.all_values()
    change(values)
    assert config.save(values) == []


# --- The schema ---------------------------------------------------------------


def test_only_client_settings_and_keybinds_are_the_users():
    for (section, key), spec in SETTINGS.items():
        assert bool(spec.get("user")) == (spec["scope"] == "client"), f"{section}.{key}"
    assert all(action.get("user") for action in SCHEMA["keybinds"])
    assert SETTINGS[("visuals", "node_brightness")]["default"] == 1.0


# --- Pure rules ---------------------------------------------------------------


def test_validate_overrides_refuses_what_a_user_cannot_set():
    keys = default_keybinds()
    assert validate_overrides({"flight": {"mouse_sensitivity": 2}}, keys) == (
        {"flight": {"mouse_sensitivity": 2.0}},
        [],
    )
    clean, errors = validate_overrides({"server": {"max_upload_mb": 5}}, keys)
    assert clean == {}
    assert errors == ["server.max_upload_mb: only the server admin sets this"]
    _, errors = validate_overrides({"flight": {"warp": 1}, "visuals": {"node_brightness": 9}}, keys)
    assert errors == ["flight.warp: no such setting", "visuals.node_brightness: must be between 0.25 and 2"]
    _, errors = validate_overrides({"keybinds": {"heat": ["Ctrl+W"]}}, keys)
    assert errors == ["keybinds.heat: Ctrl+W: the browser keeps it"]
    _, errors = validate_overrides({"keybinds": {"warp": ["J"]}}, keys)
    assert errors == ["keybinds.warp: no such action"]


def test_validate_overrides_checks_keys_against_the_admins():
    keys = default_keybinds()
    # B is balance's while flying: heat can't have it too.
    _, errors = validate_overrides({"keybinds": {"heat": ["B"]}}, keys)
    assert any(e.startswith("keybinds.heat: B clashes with balance") for e in errors)
    # Moving balance off B in the same save frees it.
    clean, errors = validate_overrides({"keybinds": {"heat": ["B"], "balance": ["J"]}}, keys)
    assert errors == []
    assert clean == {"keybinds": {"heat": ["B"], "balance": ["J"]}}


def test_apply_overrides_drops_what_stopped_working():
    client = {"keybinds": {**default_keybinds(), "balance": ["J"]}, "flight": {"mouse_sensitivity": 1.0}}
    # Saved while J was free; the admin has since given J to balance.
    merged, kept, problems = apply_overrides(
        client, {"keybinds": {"heat": ["J"], "orbit": ["K"]}, "flight": {"mouse_sensitivity": 3.0}}
    )
    assert merged["keybinds"]["heat"] == ["H"]
    assert merged["keybinds"]["orbit"] == ["K"]
    assert merged["keybinds"]["balance"] == ["J"]
    assert merged["flight"]["mouse_sensitivity"] == 3.0
    assert kept == {"flight": {"mouse_sensitivity": 3.0}, "keybinds": {"orbit": ["K"]}}
    assert problems == ["keybinds.heat: your keys for this no longer work here; the default is used"]


# --- Routes -------------------------------------------------------------------


def test_nothing_set_means_the_admins_values(alice):
    body = alice.get("/api/account/settings").json
    assert body["overrides"] == {}
    assert body["problems"] == []
    assert body["effective"] == body["server"]
    assert body["server"]["visuals"]["node_brightness"] == 1.0


def test_a_users_settings_reach_only_their_config(accounts_app, alice, bob):
    response = put(alice, {"flight": {"mouse_sensitivity": 2.5}, "keybinds": {"heat": ["J"]}})
    assert response.status_code == 200, response.json
    assert response.json["overrides"] == {"flight": {"mouse_sensitivity": 2.5}, "keybinds": {"heat": ["J"]}}

    mine = alice.get("/api/config").json
    assert mine["account"] is True
    assert mine["flight"]["mouse_sensitivity"] == 2.5
    assert mine["keybinds"]["heat"] == ["J"]
    assert mine["keybinds"]["balance"] == ["B"]

    theirs = bob.get("/api/config").json
    assert theirs["account"] is True
    assert theirs["flight"]["mouse_sensitivity"] == 1.0
    assert theirs["keybinds"]["heat"] == ["H"]

    signed_out = accounts_app.test_client().get("/api/config").json
    assert "account" not in signed_out
    assert signed_out["keybinds"]["heat"] == ["H"]


def test_admin_values_stay_the_default_underneath(accounts_app, alice):
    put(alice, {"flight": {"mouse_sensitivity": 2.5}})
    admin_save(accounts_app, lambda v: v["flight"].update(move_speed=200, mouse_sensitivity=0.5))
    config = alice.get("/api/config").json
    assert config["flight"]["move_speed"] == 200
    assert config["flight"]["mouse_sensitivity"] == 2.5


def test_put_replaces_and_refuses_whole(alice):
    put(alice, {"flight": {"invert_y": True}})
    response = put(alice, {"visuals": {"node_brightness": 1.5}, "server": {"max_upload_mb": 1}})
    assert response.status_code == 400
    assert response.json["errors"] == ["server.max_upload_mb: only the server admin sets this"]
    # Refused whole: the earlier save still stands.
    assert alice.get("/api/account/settings").json["overrides"] == {"flight": {"invert_y": True}}

    assert put(alice, {"visuals": {"node_brightness": 1.5}}).json["overrides"] == {"visuals": {"node_brightness": 1.5}}
    assert put(alice, {}).json["overrides"] == {}


def test_patch_merges_and_null_removes(alice):
    put(alice, {"flight": {"invert_y": True}, "keybinds": {"heat": ["J"]}})
    body = patch(alice, {"visuals": {"look": "deep-sea"}}).json
    assert body["overrides"] == {
        "flight": {"invert_y": True},
        "keybinds": {"heat": ["J"]},
        "visuals": {"look": "deep-sea"},
    }
    body = patch(alice, {"flight": {"invert_y": None}, "keybinds": {"heat": None}}).json
    assert body["overrides"] == {"visuals": {"look": "deep-sea"}}
    assert patch(alice, {"visuals": {"look": "no-such-look"}}).status_code == 400


def test_an_admin_change_that_breaks_a_users_key(accounts_app, alice):
    put(alice, {"keybinds": {"heat": ["J"]}, "flight": {"invert_y": True}})
    admin_save(accounts_app, lambda v: v["keybinds"].update(balance=["J"]))

    config = alice.get("/api/config").json
    assert config["keybinds"]["heat"] == ["H"]
    assert config["keybinds"]["balance"] == ["J"]
    assert config["flight"]["invert_y"] is True

    body = alice.get("/api/account/settings").json
    assert body["overrides"] == {"flight": {"invert_y": True}}
    assert body["problems"] == ["keybinds.heat: your keys for this no longer work here; the default is used"]
    # The broken key doesn't block other changes.
    assert patch(alice, {"visuals": {"look": "minimal"}}).status_code == 200


def test_needs_a_session_and_the_csrf_header(accounts_app, alice):
    anonymous = accounts_app.test_client()
    assert anonymous.get("/api/account/settings").status_code == 401
    assert anonymous.put("/api/account/settings", json={}, headers=CSRF).status_code == 401
    assert alice.put("/api/account/settings", json={}).status_code == 403
    assert alice.patch("/api/account/settings", json={}).status_code == 403
    assert put(alice, ["not", "an", "object"]).status_code == 400


def test_accounts_off(isolated_config):
    from server import create_app

    app = create_app()
    client = app.test_client()
    assert client.get("/api/account/settings").status_code == 404
    config = client.get("/api/config").json
    assert "account" not in config
    # No database for a server that never switched accounts on.
    assert not (isolated_config.parent / "atlasmap.db").exists()


def test_config_does_not_slide_the_session(accounts_app, alice, monkeypatch):
    import importlib

    accounts_module = importlib.import_module("server.accounts")
    db = accounts_app.extensions["atlasmap_db"]
    with db.connect() as conn:
        conn.execute("UPDATE sessions SET last_seen_at = last_seen_at - 7200, expires_at = expires_at - 7200")
        (before,) = conn.execute("SELECT expires_at FROM sessions").fetchone()
    response = alice.get("/api/config")
    assert response.json["account"] is True
    assert accounts_module.COOKIE not in (response.headers.get("Set-Cookie") or "")
    with db.connect() as conn:
        (after,) = conn.execute("SELECT expires_at FROM sessions").fetchone()
    assert after == before


def test_settings_go_with_the_account(accounts_app, alice):
    put(alice, {"flight": {"invert_y": True}})
    db = accounts_app.extensions["atlasmap_db"]
    with db.connect() as conn:
        conn.execute("DELETE FROM users WHERE username = 'alice'")
        assert conn.execute("SELECT COUNT(*) FROM user_settings").fetchone()[0] == 0
