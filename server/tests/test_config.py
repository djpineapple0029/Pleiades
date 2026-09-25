"""The config file (server/config.py) and the /admin endpoints (server/admin.py)."""

from __future__ import annotations

import io
import time

import pytest

from server import create_app
from server.config import (
    ConfigStore,
    default_keybinds,
    hash_password,
    parse_chord,
    ChordError,
    chord_text,
    validate_keybinds,
    verify_password,
)

PASSWORD = "correct horse"


@pytest.fixture
def store(isolated_config) -> ConfigStore:
    s = ConfigStore(isolated_config)
    s.password_hash = hash_password(PASSWORD)
    return s


@pytest.fixture
def app(isolated_config):
    app = create_app()
    config = app.extensions["atlasmap_config"]
    config.set_password(config.initial_password, PASSWORD)
    return app


@pytest.fixture
def client(app):
    return app.test_client()


def sign_in(client) -> dict:
    response = client.post("/api/admin/login", json={"password": PASSWORD})
    assert response.status_code == 200, response.json
    return {"Authorization": f"Bearer {response.json['token']}"}


# --- Chords -------------------------------------------------------------------


def test_chords_parse_to_canonical_text():
    assert chord_text(parse_chord("shift+mod+s")) == "Mod+Shift+S"
    assert chord_text(parse_chord("Shift+?")) == "?"
    assert chord_text(parse_chord("arrowup")) == "ArrowUp"


@pytest.mark.parametrize("bad", ["", "Mod+", "Hyper+S", "Mod+Ctrl+S", "NumpadEnter", "Shift+Shift", 5])
def test_unreadable_chords_are_refused(bad):
    with pytest.raises(ChordError):
        parse_chord(bad)


def test_defaults_validate_clean():
    keybinds, errors = validate_keybinds(default_keybinds())
    assert errors == []
    assert keybinds == default_keybinds()


@pytest.mark.parametrize(
    ("change", "fragment"),
    [
        ({"balance": ["W"]}, "clashes with fly forward"),  # both live while flying
        ({"save": ["Mod+W"]}, "browser keeps it"),  # closes the tab
        ({"save": ["Mod+3"]}, "switches browser tabs"),
        ({"search": ["Shift+K"]}, "add a modifier"),  # fires while flying down
        ({"move_forward": ["Alt+J"]}, "no modifiers"),
        ({"move_forward": ["/"]}, "by position"),
        ({"overview": []}, "at least one key"),
        ({"balance": ["Escape"]}, "releases the pointer"),
        ({"nope": ["B"]}, "no such action"),
        ({"balance": ["A", "B", "C", "E"]}, "at most 3"),
    ],
)
def test_keybind_rules(change, fragment):
    _keybinds, errors = validate_keybinds({**default_keybinds(), **change})
    assert any(fragment in e for e in errors), errors


def test_actions_that_are_never_live_together_may_share_a_chord():
    # Enter is both "resume" (pointer free) and "rename" (flying) by default.
    _keybinds, errors = validate_keybinds({**default_keybinds(), "help": ["Enter"], "resume": ["F2"]})
    assert errors == []


def test_mod_overlaps_ctrl():
    _keybinds, errors = validate_keybinds({**default_keybinds(), "balance": ["Ctrl+S"]})
    assert any(e.startswith("keybinds.balance: Ctrl+S clashes with save") for e in errors), errors
    assert any(e.startswith("keybinds.save: Ctrl+S clashes with balance") for e in errors), errors


# --- The file -----------------------------------------------------------------


def test_first_run_writes_defaults_and_only_a_hash(isolated_config, capsys):
    s = ConfigStore(isolated_config)
    text = isolated_config.read_text()
    printed = capsys.readouterr().err
    assert s.initial_password and s.initial_password in printed
    assert s.initial_password not in text
    assert 'password_hash = "scrypt$' in text
    assert 'balance = ["B"]' in text
    assert s.check_password(s.initial_password)
    assert oct(isolated_config.stat().st_mode & 0o777) == "0o600"


def test_hand_typed_password_is_hashed_and_removed(store, isolated_config):
    text = isolated_config.read_text().replace('password = ""', 'password = "typed by hand"')
    isolated_config.write_text(text)
    store.load()
    assert store.check_password("typed by hand")
    assert "typed by hand" not in isolated_config.read_text()


def test_hand_edits_keep_comments_through_a_panel_save(store, isolated_config):
    text = isolated_config.read_text().replace('balance = ["B"]', 'balance = ["G"] # mine')
    isolated_config.write_text(text + "\n# a note at the end\n")
    store.load()
    assert store.values["keybinds"]["balance"] == ["G"]
    values = store.all_values()
    values["flight"]["move_speed"] = 150
    assert store.save(values) == []
    text = isolated_config.read_text()
    assert "# mine" in text and "# a note at the end" in text
    assert "move_speed = 150" in text


def test_bad_hand_edits_fall_back_and_are_reported(store, isolated_config):
    text = isolated_config.read_text()
    text = text.replace("mouse_sensitivity = 1.0", "mouse_sensitivity = 99")
    text = text.replace('balance = ["B"]', 'balance = ["W"]')
    isolated_config.write_text(text)
    store.load()
    assert store.values["flight"]["mouse_sensitivity"] == 1.0
    assert store.values["keybinds"] == default_keybinds()
    assert any("mouse_sensitivity" in p for p in store.problems)
    assert any("balance" in p for p in store.problems)


def test_broken_toml_keeps_the_last_good_values(store, isolated_config):
    values = store.all_values()
    values["flight"]["invert_y"] = True
    store.save(values)
    isolated_config.write_text("this is [not toml")
    store.load()
    assert store.values["flight"]["invert_y"] is True
    assert store.problems and "could not be read" in store.problems[0]


def test_a_strict_save_writes_nothing_on_any_error(store, isolated_config):
    before = isolated_config.read_text()
    values = store.all_values()
    values["flight"]["move_speed"] = 150
    values["keybinds"]["save"] = ["Mod+N"]
    assert store.save(values)
    assert isolated_config.read_text() == before


def test_passwords():
    stored = hash_password("abc12345")
    assert verify_password("abc12345", stored)
    assert not verify_password("abc12346", stored)
    assert not verify_password("abc12345", "garbage")


# --- Endpoints ----------------------------------------------------------------


def test_public_config_has_no_secrets(client):
    body = client.get("/api/config").json
    assert body["keybinds"]["balance"] == ["B"]
    assert body["flight"]["move_speed"] == 90
    assert "admin" not in body and "server" not in body


def test_admin_page_is_served_hardened(client):
    response = client.get("/admin")
    assert response.status_code == 200
    assert b"AtlasMap Admin" in response.data
    assert "frame-ancestors 'none'" in response.headers["Content-Security-Policy"]
    assert client.get("/admin/admin.js").status_code == 200
    assert client.get("/admin/../config.py").status_code == 404
    assert client.get("/admin/").headers["Location"] == "../admin"


def test_admin_endpoints_need_a_session(client):
    assert client.get("/api/admin/config").status_code == 401
    assert client.get("/api/admin/config", headers={"Authorization": "Bearer nope"}).status_code == 401
    assert client.post("/api/admin/login", json={"password": "wrong"}).status_code == 401


def test_save_through_the_panel_reaches_the_public_config(client):
    auth = sign_in(client)
    values = client.get("/api/admin/config", headers=auth).json["values"]
    values["keybinds"]["balance"] = ["G"]
    values["visuals"]["bloom_strength"] = 0.5
    assert client.put("/api/admin/config", json=values, headers=auth).status_code == 200
    public = client.get("/api/config").json
    assert public["keybinds"]["balance"] == ["G"]
    assert public["visuals"]["bloom_strength"] == 0.5


def test_a_refused_save_lists_every_error(client):
    auth = sign_in(client)
    values = client.get("/api/admin/config", headers=auth).json["values"]
    values["keybinds"]["balance"] = ["W"]
    values["flight"]["move_speed"] = -1
    response = client.put("/api/admin/config", json=values, headers=auth)
    assert response.status_code == 400
    # The clash on both actions, and the speed.
    assert len(response.json["errors"]) == 3


def test_upload_ceiling_follows_the_config(client):
    auth = sign_in(client)
    values = client.get("/api/admin/config", headers=auth).json["values"]
    values["server"]["max_upload_mb"] = 1
    client.put("/api/admin/config", json=values, headers=auth)
    big = b"x" * (2 * 1024 * 1024)
    response = client.post("/api/open", data={"file": (io.BytesIO(big), "a.atlasmap")})
    assert response.status_code == 413


def test_change_password_needs_the_current_one_and_signs_out_other_tabs(client, app):
    auth = sign_in(client)
    other = sign_in(client)
    wrong = client.post("/api/admin/password", json={"current": "nope", "new": "new password 1"}, headers=auth)
    assert wrong.status_code == 401
    short = client.post("/api/admin/password", json={"current": PASSWORD, "new": "short"}, headers=auth)
    assert short.status_code == 400
    ok = client.post("/api/admin/password", json={"current": PASSWORD, "new": "new password 1"}, headers=auth)
    assert ok.status_code == 200
    assert client.get("/api/admin/config", headers=other).status_code == 401
    fresh = {"Authorization": f"Bearer {ok.json['token']}"}
    assert client.get("/api/admin/config", headers=fresh).status_code == 200
    assert client.post("/api/admin/login", json={"password": "new password 1"}).status_code == 200
    assert client.post("/api/admin/login", json={"password": PASSWORD}).status_code == 401


def test_wrong_passwords_lock_an_address_out(client, app):
    for _ in range(5):
        assert client.post("/api/admin/login", json={"password": "wrong"}).status_code == 401
    locked = client.post("/api/admin/login", json={"password": PASSWORD})
    assert locked.status_code == 429
    assert int(locked.headers["Retry-After"]) > 0
    # Another address is unaffected.
    other = client.post("/api/admin/login", json={"password": PASSWORD}, environ_base={"REMOTE_ADDR": "10.0.0.9"})
    assert other.status_code == 200


def test_outside_allowed_networks_is_a_404(client):
    auth = sign_in(client)
    values = client.get("/api/admin/config", headers=auth).json["values"]
    values["admin"]["allowed_networks"] = ["127.0.0.0/8"]
    assert client.put("/api/admin/config", json=values, headers=auth).status_code == 200
    outsider = {"REMOTE_ADDR": "192.168.1.50"}
    assert client.get("/admin", environ_base=outsider).status_code == 404
    assert client.post("/api/admin/login", json={"password": PASSWORD}, environ_base=outsider).status_code == 404
    # The public app is not affected.
    assert client.get("/api/config", environ_base=outsider).status_code == 200


def test_a_save_that_would_lock_you_out_is_refused(client):
    auth = sign_in(client)
    values = client.get("/api/admin/config", headers=auth).json["values"]
    values["admin"]["allowed_networks"] = ["10.0.0.0/8"]
    response = client.put("/api/admin/config", json=values, headers=auth)
    assert response.status_code == 400
    assert "lock you out" in response.json["errors"][0]


def test_trusted_proxy_hop_decides_the_client_address(client):
    auth = sign_in(client)
    values = client.get("/api/admin/config", headers=auth).json["values"]
    values["admin"]["trusted_proxies"] = 1
    client.put("/api/admin/config", json=values, headers=auth)
    # Behind one proxy, the last X-Forwarded-For entry is the real browser.
    for _ in range(5):
        client.post("/api/admin/login", json={"password": "x"}, headers={"X-Forwarded-For": "1.2.3.4, 5.6.7.8"})
    blocked = client.post("/api/admin/login", json={"password": PASSWORD}, headers={"X-Forwarded-For": "5.6.7.8"})
    assert blocked.status_code == 429
    other = client.post("/api/admin/login", json={"password": PASSWORD}, headers={"X-Forwarded-For": "9.9.9.9"})
    assert other.status_code == 200


def test_status_reports_requests(client):
    auth = sign_in(client)
    client.get("/api/config")
    body = client.get("/api/admin/status", headers=auth).json
    assert body["requests"]["total"] >= 2
    assert all(r["path"] != "/api/admin/status" for r in body["requests"]["recent"])
    assert body["server"]["password_generated"] is False


def test_hand_edit_applies_without_a_restart(app, client, isolated_config):
    config = app.extensions["atlasmap_config"]
    text = isolated_config.read_text().replace('balance = ["B"]', 'balance = ["J"]')
    time.sleep(0.01)  # a distinct mtime
    isolated_config.write_text(text)
    config._checked = 0
    assert client.get("/api/config").json["keybinds"]["balance"] == ["J"]
